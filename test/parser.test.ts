/**
 * parser.test.ts - 跨语言源码片段解析测试（fixture 驱动）
 *
 * 结构：test/fixtures/<language>/<file>
 * 每个文件是一个独立语言的源码片段，测试用对应的 languageId 调用
 * DocCommentParser.parse()，断言 typeGroups / methods / fields /
 * enumConstants 的结构与注释。
 *
 * 环境说明：
 * - vscode mock 的 executeDocumentSymbolProvider 返回 []（模拟无 Language
 *   Server），解析走 tree-sitter AST 兜底链路，同时验证 AST 成员提取。
 * - 成员列表按源码行号排序，与侧边栏展示顺序一致。
 */

import * as fs from "fs";
import * as path from "path";
import { DocCommentParser } from "../src/parser/DocCommentParser";
import type { ClassDoc } from "../src/types";
import type { TextDocument } from "vscode";
import { Uri } from "./mocks/vscode";

// WASM grammar 首次加载较慢，放宽默认超时
jest.setTimeout(120000);

const parser = new DocCommentParser();
const FIXTURES_ROOT = path.join(__dirname, "fixtures");

/** 构造 TextDocument mock */
function makeDoc(
  languageId: string,
  filePath: string,
  text: string,
): TextDocument {
  return {
    uri: Uri.file(filePath),
    languageId,
    getText: () => text,
  } as TextDocument;
}

/** 读取 fixture 文件并解析 */
async function parseFixture(
  languageId: string,
  file: string,
): Promise<ClassDoc> {
  const filePath = path.join(FIXTURES_ROOT, languageId, file);
  const text = fs.readFileSync(filePath, "utf8");
  return parser.parse(makeDoc(languageId, filePath, text));
}

/** 提取成员名称列表（保持源码顺序） */
function names(items: readonly { name: string }[]): string[] {
  return items.map((i) => i.name);
}

describe("Java (fixtures/java/UserService.java)", () => {
  it("类型组：UserService + 内部类 UserHelper", async () => {
    const doc = await parseFixture("java", "UserService.java");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "UserService",
      "UserService.UserHelper",
    ]);
    // 类注释位于文件开头，被识别为文件头（去重后类型卡片不重复展示），
    // 文件级注释 classComment 保留描述
    expect(doc.classComment).toContain("用户服务类");
    expect(doc.typeGroups[1]?.comment).toContain("用户助手类");
  });

  it("字段与方法按源码顺序", async () => {
    const doc = await parseFixture("java", "UserService.java");
    expect(names(doc.fields)).toEqual(["cache"]);
    expect(names(doc.methods)).toEqual(["findById", "save", "buildName"]);
  });

  it("findById：@param/@return/@throws 标签解析", async () => {
    const doc = await parseFixture("java", "UserService.java");
    const m = doc.methods.find((x) => x.name === "findById");
    expect(m?.hasComment).toBe(true);
    expect(m?.description).toContain("根据 ID 查询用户");
    expect(m?.tags.params).toHaveLength(1);
    expect(m?.tags.params[0]).toMatchObject({
      name: "id",
      type: "Long",
      description: "用户ID",
    });
    expect(m?.tags.returns?.description).toContain("用户对象");
    expect(m?.tags.throws[0]?.type).toBe("IllegalArgumentException");
  });

  it("内部类方法归属 UserService.UserHelper", async () => {
    const doc = await parseFixture("java", "UserService.java");
    const m = doc.methods.find((x) => x.name === "buildName");
    expect(m?.belongsTo).toBe("UserService.UserHelper");
    expect(m?.hasComment).toBe(true);
  });
});

describe("TypeScript (fixtures/typescript/User.ts)", () => {
  it("类型组：User / Gender / IUser", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "Gender",
      "IUser",
    ]);
  });

  it("类 User：字段与方法注释", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(names(doc.fields)).toEqual(["id", "name", "id"]);
    const getId = doc.methods.find((m) => m.name === "getId");
    expect(getId?.hasComment).toBe(true);
    expect(getId?.description).toContain("获取 ID");
    expect(getId?.returnType).toBe("number");
  });

  it("枚举：MALE / FEMALE 提取为枚举常量", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(names(doc.enumConstants)).toEqual(["MALE", "FEMALE"]);
  });

  it("顶层箭头函数识别为方法", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    const createUser = doc.methods.find((m) => m.name === "createUser");
    expect(createUser).toBeDefined();
    expect(createUser?.hasComment).toBe(true);
    expect(createUser?.description).toContain("创建用户工厂");
  });
});

describe("JavaScript (fixtures/javascript/Utils.js)", () => {
  it("类 Utils：静态字段与方法", async () => {
    const doc = await parseFixture("javascript", "Utils.js");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Utils"]);
    expect(names(doc.fields)).toEqual(["count"]);
    // Utils 是构造函数（按 LSP 约定以类名命名）
    expect(names(doc.methods)).toEqual(["Utils", "increment", "decrement", "sum"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    const increment = doc.methods.find((m) => m.name === "increment");
    expect(increment?.hasComment).toBe(true);
    expect(increment?.description).toContain("增加计数");
  });
});

describe("C (fixtures/c/Shape.c)", () => {
  it("结构体 Shape：字段与方法", async () => {
    const doc = await parseFixture("c", "Shape.c");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape"]);
    expect(names(doc.fields)).toEqual(["width", "height"]);
    expect(names(doc.methods)).toEqual(["area"]);
    expect(doc.methods[0]?.hasComment).toBe(true);
  });
});

describe("Python (fixtures/python/Calculator.py)", () => {
  it("类 Calculator：方法与注解字段", async () => {
    const doc = await parseFixture("python", "Calculator.py");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Calculator"]);
    expect(names(doc.methods)).toEqual(["add", "sub"]);
    expect(names(doc.fields)).toEqual(["count"]);
  });
});

describe("Go (fixtures/go/Order.go)", () => {
  it("结构体 Order：字段与方法（// 行注释作为文档）", async () => {
    const doc = await parseFixture("go", "Order.go");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Order"]);
    expect(names(doc.fields)).toEqual(["ID", "Amount"]);
    expect(names(doc.methods)).toEqual(["NewOrder", "Total"]);
    const newOrder = doc.methods.find((m) => m.name === "NewOrder");
    expect(newOrder?.hasComment).toBe(true);
    expect(newOrder?.description).toContain("创建订单");
  });
});

describe("Rust (fixtures/rust/Parser.rs)", () => {
  it("结构体 Parser：字段与方法（/// 行注释作为文档）", async () => {
    const doc = await parseFixture("rust", "Parser.rs");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Parser"]);
    expect(names(doc.fields)).toEqual(["line"]);
    expect(names(doc.methods)).toEqual(["new", "advance"]);
    expect(doc.methods[0]?.description).toContain("创建解析器");
  });
});

// ========== 扩展语言：更多文件类型与语法情形 ==========

describe("C++ (fixtures/cpp/Shape.cpp)", () => {
  it("类 Shape + 枚举 Color：字段/方法/枚举成员", async () => {
    const doc = await parseFixture("cpp", "Shape.cpp");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape", "Color"]);
    expect(names(doc.fields)).toEqual(["width", "height"]);
    // C++ grammar 将构造函数/析构函数统一表示为 function_definition，
    // 构造函数与析构函数均以类名 Shape 命名
    expect(names(doc.methods)).toEqual(["Shape", "area", "Shape"]);
    expect(names(doc.enumConstants)).toEqual(["RED", "GREEN", "BLUE"]);
  });

  it("构造函数与 area 方法注释提取", async () => {
    const doc = await parseFixture("cpp", "Shape.cpp");
    const area = doc.methods.find((m) => m.name === "area");
    expect(area?.hasComment).toBe(true);
    expect(area?.description).toContain("计算面积");
    const ctor = doc.methods[0];
    expect(ctor?.hasComment).toBe(true);
    expect(ctor?.description).toContain("构造函数");
  });
});

describe("C# (fixtures/csharp/User.cs)", () => {
  it("类 User + 接口 IUser + 枚举 UserType", async () => {
    const doc = await parseFixture("csharp", "User.cs");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "UserType",
    ]);
    expect(names(doc.methods)).toEqual(["User", "GetId", "GetName"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["Id", "Name"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "NORMAL"]);
  });

  it("属性 Name 与 GetId 方法注释", async () => {
    const doc = await parseFixture("csharp", "User.cs");
    const nameField = doc.fields.find((f) => f.name === "Name");
    expect(nameField?.hasComment).toBe(true);
    expect(nameField?.description).toContain("用户名");
    const getter = doc.methods.find((m) => m.name === "GetId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
  });
});

describe("TypeScript React (fixtures/typescriptreact/Component.tsx)", () => {
  it("接口 IProps + 类 Button + 顶层箭头函数 App", async () => {
    const doc = await parseFixture("typescriptreact", "Component.tsx");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["IProps", "Button"]);
    // interface 方法签名 onClick + 类方法 render + 顶层箭头函数 App
    expect(names(doc.methods)).toEqual(["onClick", "render", "App"]);
    // interface 属性 title + 静态字段 displayName
    expect(names(doc.fields)).toEqual(["title", "displayName"]);
  });

  it("箭头函数组件 App 的注释", async () => {
    const doc = await parseFixture("typescriptreact", "Component.tsx");
    const app = doc.methods.find((m) => m.name === "App");
    expect(app?.hasComment).toBe(true);
    expect(app?.description).toContain("纯函数组件");
  });
});

describe("JavaScript React (fixtures/javascriptreact/App.jsx)", () => {
  it("类 App + 顶层函数组件 Header", async () => {
    const doc = await parseFixture("javascriptreact", "App.jsx");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["App"]);
    expect(names(doc.methods)).toEqual(["increment", "decrement", "Header"]);
    expect(names(doc.fields)).toEqual(["state"]);
  });

  it("类方法 increment 注释", async () => {
    const doc = await parseFixture("javascriptreact", "App.jsx");
    const inc = doc.methods.find((m) => m.name === "increment");
    expect(inc?.hasComment).toBe(true);
    expect(inc?.description).toContain("增加计数");
  });
});

describe("PHP (fixtures/php/User.php)", () => {
  it("类 User + 接口 IUser + 枚举 Role", async () => {
    const doc = await parseFixture("php", "User.php");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "Role",
    ]);
    expect(names(doc.methods)).toEqual(["__construct", "getId", "getName"]);
    expect(names(doc.fields)).toEqual(["$id"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "USER"]);
  });

  it("字段 $id 与方法 getId 注释", async () => {
    const doc = await parseFixture("php", "User.php");
    const idField = doc.fields[0];
    expect(idField?.hasComment).toBe(true);
    expect(idField?.description).toContain("用户ID");
    const getter = doc.methods.find((m) => m.name === "getId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
  });
});

describe("Kotlin (fixtures/kotlin/User.kt)", () => {
  it("类 User + 接口 IUser + 枚举 Role", async () => {
    const doc = await parseFixture("kotlin", "User.kt");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "Role",
    ]);
    expect(names(doc.methods)).toEqual(["User", "getId", "empty", "getName"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    // type_identifier 降级修复：字段名为 name 而非类型 String
    expect(names(doc.fields)).toEqual(["name"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "USER"]);
  });

  it("companion object 方法 empty 与字段注释", async () => {
    const doc = await parseFixture("kotlin", "User.kt");
    const empty = doc.methods.find((m) => m.name === "empty");
    expect(empty?.hasComment).toBe(true);
    expect(empty?.description).toContain("创建空用户");
    expect(doc.fields[0]?.description).toContain("用户名");
  });
});

describe("Swift (fixtures/swift/User.swift)", () => {
  it("类 User + 协议 Describable + 枚举 Color", async () => {
    const doc = await parseFixture("swift", "User.swift");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "Describable",
      "Color",
    ]);
    expect(names(doc.methods)).toEqual(["User", "description", "describe"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["id", "name"]);
    expect(names(doc.enumConstants)).toEqual(["red", "green"]);
  });

  it("init 构造器与 description 方法注释", async () => {
    const doc = await parseFixture("swift", "User.swift");
    const desc = doc.methods.find((m) => m.name === "description");
    expect(desc?.hasComment).toBe(true);
    expect(desc?.description).toContain("获取描述");
  });
});

describe("Scala (fixtures/scala/User.scala)", () => {
  it("类 User + 特质 IUser + 对象 UserFactory", async () => {
    const doc = await parseFixture("scala", "User.scala");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "UserFactory",
    ]);
    expect(names(doc.methods)).toEqual(["getId", "create"]);
    expect(names(doc.fields)).toEqual(["name"]);
  });

  it("工厂方法 create 注释", async () => {
    const doc = await parseFixture("scala", "User.scala");
    const create = doc.methods.find((m) => m.name === "create");
    expect(create?.hasComment).toBe(true);
    expect(create?.description).toContain("创建用户");
  });
});

describe("Objective-C (fixtures/objective-c/User.h)", () => {
  it("@protocol IUser + @interface User", async () => {
    const doc = await parseFixture("objective-c", "User.h");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["IUser", "User"]);
    expect(names(doc.methods)).toEqual(["getName", "getUserId"]);
    expect(names(doc.fields)).toEqual(["userId"]);
  });

  it("方法 getUserId 与属性 userId 注释", async () => {
    const doc = await parseFixture("objective-c", "User.h");
    const getter = doc.methods.find((m) => m.name === "getUserId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
    expect(doc.fields[0]?.description).toContain("用户ID");
  });
});

describe("Ruby (fixtures/ruby/user.rb)", () => {
  it("已知限制：tree-sitter-ruby grammar 与 web-tree-sitter 0.20.8 不兼容", async () => {
    // grammar 解析抛错被 parse 内部捕获，返回空结构而非崩溃
    const doc = await parseFixture("ruby", "user.rb");
    expect(doc.typeGroups).toHaveLength(0);
    expect(doc.methods).toHaveLength(0);
    expect(doc.fields).toHaveLength(0);
  });
});

// ========== 既有语言补充情形 ==========

describe("Java 带值枚举 (fixtures/java/OrderStatus.java)", () => {
  it("带构造参数枚举 + getter 方法", async () => {
    const doc = await parseFixture("java", "OrderStatus.java");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["OrderStatus"]);
    expect(names(doc.methods)).toEqual(["OrderStatus", "getCode"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["code", "value"]);
    expect(names(doc.enumConstants)).toEqual(["PENDING", "PAID", "CANCELLED"]);
  });

  it("枚举常量 PENDING 注释与归属", async () => {
    const doc = await parseFixture("java", "OrderStatus.java");
    const pending = doc.enumConstants.find((e) => e.name === "PENDING");
    expect(pending?.hasComment).toBe(true);
    expect(pending?.description).toContain("待支付");
    expect(pending?.belongsTo).toBe("OrderStatus");
  });
});

describe("TypeScript 泛型 (fixtures/typescript/Generic.ts)", () => {
  it("泛型约束不泄漏为字段（type_parameters 跳过）", async () => {
    const doc = await parseFixture("typescript", "Generic.ts");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Repository",
      "UserType",
    ]);
    expect(names(doc.methods)).toEqual(["save", "findById"]);
    // items 属于 Repository；id/name 属于 UserType 接口
    expect(names(doc.fields)).toEqual(["items", "id", "name"]);
  });

  it("泛型方法 save 注释", async () => {
    const doc = await parseFixture("typescript", "Generic.ts");
    const save = doc.methods.find((m) => m.name === "save");
    expect(save?.hasComment).toBe(true);
    expect(save?.description).toContain("保存项目");
  });
});

describe("C 枚举 + 联合 (fixtures/c/Color.c)", () => {
  it("枚举 Color 与联合 Value", async () => {
    const doc = await parseFixture("c", "Color.c");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Color", "Value"]);
    expect(names(doc.enumConstants)).toEqual(["RED", "GREEN", "BLUE"]);
    expect(names(doc.fields)).toEqual(["i", "f"]);
    expect(doc.typeGroups[1]?.comment).toContain("联合体");
  });
});

describe("Python 继承 (fixtures/python/shapes.py)", () => {
  it("类 Shape 与子类 Circle：方法重写 + 注解字段", async () => {
    const doc = await parseFixture("python", "shapes.py");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape", "Circle"]);
    expect(names(doc.methods)).toEqual(["area", "area"]);
    expect(names(doc.fields)).toEqual(["radius"]);
  });

  it("已知限制：docstring 位于类/函数体内，插件不识别为注释", async () => {
    // Python 文档字符串是声明后的第一个表达式（类体/函数体内），
    // 而插件按「声明上方注释」向上搜索，故 hasComment 为 false。
    // 与 Calculator.py（python/fixtures 既有 fixture）行为一致。
    const doc = await parseFixture("python", "shapes.py");
    expect(doc.methods.every((m) => !m.hasComment)).toBe(true);
    expect(doc.typeGroups.every((g) => !g.comment)).toBe(true);
  });
});

describe("Go 接口 (fixtures/go/api.go)", () => {
  it("接口 Reader 与结构体 FileReader 实现方法", async () => {
    const doc = await parseFixture("go", "api.go");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Reader",
      "FileReader",
    ]);
    expect(names(doc.methods)).toEqual(["Read"]);
    expect(names(doc.fields)).toEqual(["Path"]);
    const read = doc.methods[0];
    expect(read?.hasComment).toBe(true);
    expect(read?.description).toContain("读取文件内容");
  });
});

describe("Rust 枚举 payload + impl (fixtures/rust/linked.rs)", () => {
  it("带数据枚举 Node 与泛型实现 LinkedList", async () => {
    const doc = await parseFixture("rust", "linked.rs");
    // Node / LinkedList 为类型声明，第三个 LinkedList 为 impl 块（无注释）
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Node",
      "LinkedList",
      "LinkedList",
    ]);
    expect(names(doc.enumConstants)).toEqual(["Nil", "Cons"]);
    expect(names(doc.fields)).toEqual(["head"]);
    expect(names(doc.methods)).toEqual(["new"]);
    const newMethod = doc.methods[0];
    expect(newMethod?.hasComment).toBe(true);
    expect(newMethod?.description).toContain("创建空链表");
  });
});
