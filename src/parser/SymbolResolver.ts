/**
 * SymbolResolver.ts - 符号解析器
 *
 * 通过 VS Code 的 Document Symbol Provider 解析符号，
 * 并提供分类辅助函数供 parser 复用。
 *
 * @author xiaowu
 * @since 2026/02/04
 */

import * as vscode from "vscode";
import type { DocumentSymbol, SymbolInformation, Uri } from "vscode";

const EXECUTE_DOCUMENT_SYMBOL_PROVIDER = "vscode.executeDocumentSymbolProvider";
const MAX_CACHE_ENTRIES = 128;

/**
 * LSP 空结果重试间隔（毫秒）。
 * 语言服务器冷启动（如 clangd 建立索引）期间首次请求常返回空，
 * 直接采信会过早降级到 tree-sitter 兜底（对宏等复杂语法精度受限）。
 * 依次等待 400ms / 1200ms 后重试，最多请求 3 次。
 */
const DEFAULT_EMPTY_RETRY_DELAYS_MS: readonly number[] = [400, 1200];
let emptyRetryDelaysMs: readonly number[] = DEFAULT_EMPTY_RETRY_DELAYS_MS;

/**
 * 空结果负缓存 TTL（毫秒）。
 * 重试后仍为空的结论只短期有效：无 LSP 环境下避免每次解析都付出重试延迟，
 * TTL 过期后重新请求也给冷启动完成的语言服务器再次出结果的机会。
 */
const EMPTY_CACHE_TTL_MS = 10_000;

/** 覆盖空结果重试间隔（测试传 [] 禁用重试，避免拖慢单测） */
export function setEmptyRetryDelays(delays: readonly number[]): void {
  emptyRetryDelaysMs = delays;
}

const CLASS_LIKE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

const METHOD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Operator,
]);

const FIELD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Event,
]);

interface CachedSymbols {
  // 文档缓存版本号，用于一致性校验
  readonly version: number;
  readonly symbols: DocumentSymbol[];
  // 缓存写入时间：空结果只在 EMPTY_CACHE_TTL_MS 内有效
  readonly cachedAt: number;
}

const symbolCache = new Map<string, CachedSymbols>();
const inFlightRequests = new Map<string, Promise<DocumentSymbol[]>>();

/**
 * 清除单个文档的符号缓存。
 */
export function clearSymbolCache(uri: Uri): void {
  const cacheKey = uri.toString();
  symbolCache.delete(cacheKey);
  clearInFlightByPrefix(`${cacheKey}#`);
}

/**
 * 清除所有缓存和进行中的符号请求。
 */
export function clearAllSymbolCache(): void {
  symbolCache.clear();
  inFlightRequests.clear();
}

/**
 * 解析指定文档 URI 的符号列表。
 *
 * 策略：
 * - 相同版本号的打开文档命中 LRU 缓存时直接返回。
 * - 对相同 URI+version 的并发请求做去重。
 * - 将 provider 输出统一规范化为 DocumentSymbol[]。
 */
export async function resolveSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  const cacheKey = uri.toString();
  const version = getOpenDocumentVersion(cacheKey);

  if (version !== undefined) {
    const cached = getCachedSymbols(cacheKey, version);
    if (cached) {
      return cached;
    }
  }

  const requestKey = `${cacheKey}#${version ?? "untracked"}`;
  const pending = inFlightRequests.get(requestKey);
  if (pending) {
    return pending;
  }

  const request = fetchAndNormalizeSymbols(uri)
    .then((symbols) => {
      // 空结果也缓存（带 TTL，见 getCachedSymbols）：请求内已按
      // emptyRetryDelaysMs 重试，冷启动窗口已覆盖；缓存空结果可避免
      // 无 LSP 环境下每次刷新都重复重试。TTL 过期后自然重新请求。
      if (version !== undefined) {
        setCachedSymbols(cacheKey, version, symbols);
      }
      return symbols;
    })
    .finally(() => {
      inFlightRequests.delete(requestKey);
    });

  inFlightRequests.set(requestKey, request);
  return request;
}

/**
 * 容器类型：Class / Interface / Enum。
 */
export function isClassLikeSymbol(symbol: DocumentSymbol): boolean {
  return CLASS_LIKE_KINDS.has(symbol.kind);
}

/**
 * 判断一个 Variable 符号是否持有函数（箭头函数 / 函数表达式）。
 *
 * TS/JS language server 会将 `const f = () => {}` 报告为 SymbolKind.Variable
 * （而非 Function）。检测路径：
 *   1. TS/TSX 带类型推断：`detail` 包含函数签名
 *      （如 "(v) => number" 或 "(v): number"），检查是否匹配函数签名模式。
 *   2. JS/JSX 无类型推断（detail 为空）：不再依据 `children.length > 0` 推断
 *      —— 对象/数组字面量（如 `const x = Object.freeze({...})`）同样会产生
 *      属性子符号，children 非空不足以证明持有函数；统一由 DocCommentParser
 *      的源码文本检查（isFunctionVariableFromSource）兜底：扫描符号范围源码
 *      是否含 `=>` 或 `function` 关键字，精确无误判。
 */
function isFunctionVariableSymbol(symbol: DocumentSymbol): boolean {
  if (symbol.kind !== vscode.SymbolKind.Variable) {
    return false;
  }
  // 路径 1：detail 包含函数签名模式（带类型推断的 TS/TSX）
  return /\([^)]*\)\s*(?:=>|:)/.test(symbol.detail);
}

/**
 * 可调用成员类型：Method / Constructor / Function，以及函数类型的
 * Variable（JS/TS 中的箭头函数 / 函数表达式赋值）。
 */
export function isMethodSymbol(symbol: DocumentSymbol): boolean {
  return METHOD_KINDS.has(symbol.kind) || isFunctionVariableSymbol(symbol);
}

/**
 * 数据成员类型：Field / Constant（不含 EnumMember），以及非函数类型的
 * Variable（JS/TS 中的值绑定）。与 isMethodSymbol 互斥：
 * 函数类型的 Variable 一律视为方法，绝不归为字段。
 */
export function isFieldSymbol(symbol: DocumentSymbol): boolean {
  return (
    FIELD_KINDS.has(symbol.kind) ||
    (symbol.kind === vscode.SymbolKind.Variable &&
      !isFunctionVariableSymbol(symbol))
  );
}

/**
 * 枚举成员类型。
 */
export function isEnumMemberSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.EnumMember;
}

/**
 * 构造函数类型。
 */
export function isConstructorSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Constructor;
}

function clearInFlightByPrefix(prefix: string): void {
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) {
      inFlightRequests.delete(key);
    }
  }
}

function getCachedSymbols(
  cacheKey: string,
  version: number,
): DocumentSymbol[] | undefined {
  const cached = symbolCache.get(cacheKey);
  if (!cached || cached.version !== version) {
    return undefined;
  }

  // 空结果仅在 TTL 内有效：过期后重新请求（冷启动的 LSP 可能已就绪）。
  // 非空结果长期有效（版本号已保证一致性）。
  if (
    cached.symbols.length === 0 &&
    Date.now() - cached.cachedAt > EMPTY_CACHE_TTL_MS
  ) {
    return undefined;
  }

  // 将命中项提升到插入顺序末尾（简单的 LRU 行为）。
  symbolCache.delete(cacheKey);
  symbolCache.set(cacheKey, cached);
  return cached.symbols;
}

function setCachedSymbols(
  cacheKey: string,
  version: number,
  symbols: DocumentSymbol[],
): void {
  if (!symbolCache.has(cacheKey) && symbolCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = symbolCache.keys().next().value;
    if (typeof oldestKey === "string") {
      symbolCache.delete(oldestKey);
    }
  }

  symbolCache.set(cacheKey, {
    version,
    symbols,
    cachedAt: Date.now(),
  });
}

function getOpenDocumentVersion(cacheKey: string): number | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === cacheKey) {
    return activeDocument.version;
  }

  const document = vscode.workspace.textDocuments.find(
    (item) => item.uri.toString() === cacheKey,
  );
  return document?.version;
}

async function fetchAndNormalizeSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  let symbols = await queryDocumentSymbols(uri);
  // 冷启动重试：结果为空时按间隔重试，覆盖语言服务器初始化窗口
  for (const delay of emptyRetryDelaysMs) {
    if (symbols.length > 0) {
      break;
    }
    await sleep(delay);
    symbols = await queryDocumentSymbols(uri);
  }
  return symbols;
}

async function queryDocumentSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  try {
    const raw = await vscode.commands.executeCommand<unknown>(
      EXECUTE_DOCUMENT_SYMBOL_PROVIDER,
      uri,
    );
    return normalizeDocumentSymbols(raw);
  } catch (error) {
    console.error("[SymbolResolver] Failed to resolve symbols:", error);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDocumentSymbols(result: unknown): DocumentSymbol[] {
  if (!Array.isArray(result) || result.length === 0) {
    return [];
  }

  const first = result[0];
  if (isDocumentSymbol(first)) {
    return result as DocumentSymbol[];
  }

  if (isSymbolInformation(first)) {
    return convertSymbolInformationToDocumentSymbols(
      result as SymbolInformation[],
    );
  }

  return [];
}

function convertSymbolInformationToDocumentSymbols(
  symbols: readonly SymbolInformation[],
): DocumentSymbol[] {
  return symbols.map((symbol) => {
    const range = symbol.location.range;
    return new vscode.DocumentSymbol(
      symbol.name,
      symbol.containerName ?? "",
      symbol.kind,
      range,
      range,
    );
  });
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const symbol = value as Partial<DocumentSymbol>;
  return (
    typeof symbol.kind === "number" &&
    Array.isArray(symbol.children) &&
    isRange(symbol.range) &&
    isRange(symbol.selectionRange)
  );
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const symbol = value as Partial<SymbolInformation>;
  return (
    typeof symbol.name === "string" &&
    typeof symbol.kind === "number" &&
    isLocation(symbol.location)
  );
}

function isLocation(value: unknown): value is vscode.Location {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const location = value as Partial<vscode.Location>;
  return !!location.uri && isRange(location.range);
}

function isRange(value: unknown): value is vscode.Range {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const range = value as Partial<vscode.Range>;
  return isPosition(range.start) && isPosition(range.end);
}

function isPosition(value: unknown): value is vscode.Position {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const position = value as Partial<vscode.Position>;
  return (
    typeof position.line === "number" && typeof position.character === "number"
  );
}
