/**
 * parserEdge.test.ts - 解析器健壮性测试（编码边缘情景）
 *
 * 不依赖 fixture，直接构造源码文本，覆盖：
 * - 空文件 / 无注释成员 / 单行紧凑代码
 * - 文件头混合注释（// 行注释 + /* 块注释）
 * - 重载方法 / 纯脚本无类型文件
 */

import { DocCommentParser } from "../src/parser/DocCommentParser";
import type { ClassDoc } from "../src/types";
import type { TextDocument } from "vscode";
import { Uri } from "./mocks/vscode";

jest.setTimeout(120000);

const parser = new DocCommentParser();

function makeDoc(
  languageId: string,
  fileName: string,
  text: string,
): TextDocument {
  const filePath = `C:/fake/${fileName}`;
  return {
    uri: Uri.file(filePath),
    languageId,
    getText: () => text,
  } as TextDocument;
}

async function parse(languageId: string, fileName: string, text: string): Promise<ClassDoc> {
  return parser.parse(makeDoc(languageId, fileName, text));
}

function names(items: readonly { name: string }[]): string[] {
  return items.map((i) => i.name);
}

describe("解析器健壮性：边界输入", () => {
  it("空文件：返回空结构且不抛异常", async () => {
    const doc = await parse("java", "Empty.java", "");
    expect(doc.typeGroups).toHaveLength(0);
    expect(doc.methods).toHaveLength(0);
    expect(doc.fields).toHaveLength(0);
    expect(doc.enumConstants).toHaveLength(0);
  });

  it("只有注释没有代码", async () => {
    const doc = await parse("java", "OnlyComment.java", "/** 孤立注释 */");
    expect(doc.methods).toHaveLength(0);
    expect(doc.fields).toHaveLength(0);
  });

  it("无注释成员：hasComment 为 false", async () => {
    const doc = await parse(
      "java",
      "NoComment.java",
      `class Foo {
  int count;
  void bar() {}
}`,
    );
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Foo"]);
    expect(names(doc.fields)).toEqual(["count"]);
    expect(doc.fields[0]?.hasComment).toBe(false);
    expect(names(doc.methods)).toEqual(["bar"]);
    expect(doc.methods[0]?.hasComment).toBe(false);
  });

  it("单行紧凑代码也能提取成员", async () => {
    const doc = await parse(
      "java",
      "OneLine.java",
      "class Foo { void bar() { return; } }",
    );
    expect(names(doc.methods)).toEqual(["bar"]);
  });

  it("重载方法同名共存", async () => {
    const doc = await parse(
      "java",
      "Overload.java",
      `class Foo {
  void set(int a) {}
  void set(String s) {}
}`,
    );
    expect(names(doc.methods)).toEqual(["set", "set"]);
  });
});

describe("解析器健壮性：注释形态", () => {
  it("文件头混合注释：// 行注释 + /* 块注释合并为文件级注释", async () => {
    const doc = await parse(
      "java",
      "MixedHeader.java",
      `// 工具模块
// 第二行
/**
 * 模块说明
 *
 * @author xiaowu
 */
class Foo {}
`,
    );
    expect(doc.classComment).toContain("工具模块");
    expect(doc.classComment).toContain("第二行");
    expect(doc.classComment).toContain("模块说明");
    expect(doc.docAuthor).toBe("xiaowu");
  });

  it("方法注释带 @param 标签且跨行", async () => {
    const doc = await parse(
      "java",
      "Param.java",
      `class Foo {
  /**
   * 带参数方法
   *
   * @param a 参数A
   * @param b 参数B
   */
  void add(int a, int b) {}
}`,
    );
    const m = doc.methods.find((x) => x.name === "add");
    expect(m?.hasComment).toBe(true);
    expect(m?.tags.params).toHaveLength(2);
    expect(m?.tags.params[1]?.name).toBe("b");
  });

  it("行注释作为文档的语言（Go）：// 注释保留", async () => {
    const doc = await parse(
      "go",
      "LineDoc.go",
      `package main

// Total 总量
var Total int

// Add 累加
func Add(a int) int {
	return a
}
`,
    );
    const add = doc.methods.find((m) => m.name === "Add");
    expect(add?.hasComment).toBe(true);
    expect(add?.description).toContain("累加");
  });
});

describe("解析器健壮性：无类型脚本", () => {
  it("JavaScript 纯脚本：顶层函数与箭头函数作为方法", async () => {
    const doc = await parse(
      "javascript",
      "Script.js",
      `/** 问候 */
function greet(name) {
  return "hi " + name;
}

/** 求和箭头函数 */
const add = (a, b) => a + b;
`,
    );
    expect(names(doc.methods)).toContain("greet");
    expect(names(doc.methods)).toContain("add");
    const greet = doc.methods.find((m) => m.name === "greet");
    expect(greet?.hasComment).toBe(true);
    expect(greet?.description).toContain("问候");
  });

  it("Rust 模块级 //! 注释不污染成员描述", async () => {
    const doc = await parse(
      "rust",
      "Module.rs",
      `//! 模块级文档
//! 第二行

/// 结构体
pub struct Thing {
    /// 数值
    pub value: i32,
}

impl Thing {
    /// 创建
    pub fn new(v: i32) -> Thing {
        Thing { value: v }
    }
}
`,
    );
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Thing", "Thing"]);
    const newMethod = doc.methods.find((m) => m.name === "new");
    expect(newMethod?.hasComment).toBe(true);
    // 描述以内容开头，不含残留的 / 前缀（cleanComment 修复）
    expect(newMethod?.description).toBe("创建");
  });
});
