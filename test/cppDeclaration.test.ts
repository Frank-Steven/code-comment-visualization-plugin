/**
 * cppDeclaration.test.ts - C++ 头文件式声明与宏场景解析测试
 *
 * 覆盖 tree-sitter-cpp 的特殊节点形态（AST 兜底链路）：
 * - 无函数体的成员函数声明解析为 field_declaration(function_declarator)，
 *   需按 declarator 结构识别为方法而非字段；
 * - 无函数体的构造/析构声明解析为 declaration(function_declarator)，
 *   与函数式宏调用 AST 同构，仅当名称与外层类型同名（或为析构名）时采信；
 * - 函数指针字段（void (*handler)(int)）内层是括号包裹的指针，仍为字段；
 * - 条件编译（#ifdef / #else / #endif）两个分支的成员都应提取（并集）。
 */

import { parseText, names } from "./helpers";

describe("C++ 头文件式成员声明（无函数体）", () => {
  const HEADER = `
class Widget {
public:
  /** 构造函数 */
  Widget();
  /** 析构函数 */
  ~Widget();
  /** 获取名称 */
  std::string name() const;
  /** 设置尺寸 */
  void setSize(int w, int h);
private:
  /** 名称 */
  std::string m_name;
  /** 事件回调 */
  void (*handler)(int);
};
`;

  it("纯声明方法识别为方法并提取参数/返回类型", async () => {
    const doc = await parseText("cpp", "Widget.h", HEADER);
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Widget"]);
    expect(names(doc.methods)).toEqual(["Widget", "~Widget", "name", "setSize"]);

    const name = doc.methods.find((m) => m.name === "name");
    expect(name?.hasComment).toBe(true);
    expect(name?.description).toContain("获取名称");
    expect(name?.returnType).toBe("std::string");

    const setSize = doc.methods.find((m) => m.name === "setSize");
    expect(setSize?.params).toBe("int w, int h");
    expect(setSize?.returnType).toBe("void");
  });

  it("构造/析构声明：构造为 constructor，析构以 ~ 前缀命名为 method", async () => {
    const doc = await parseText("cpp", "Widget.h", HEADER);
    const ctor = doc.methods.find((m) => m.name === "Widget");
    expect(ctor?.kind).toBe("constructor");
    expect(ctor?.hasComment).toBe(true);
    expect(ctor?.description).toContain("构造函数");
    const dtor = doc.methods.find((m) => m.name === "~Widget");
    expect(dtor?.kind).toBe("method");
  });

  it("普通字段与函数指针字段仍为字段", async () => {
    const doc = await parseText("cpp", "Widget.h", HEADER);
    expect(names(doc.fields)).toEqual(["m_name", "handler"]);
    expect(doc.fields.find((f) => f.name === "m_name")?.type).toBe(
      "std::string",
    );
  });
});

describe("C++ 条件编译成员", () => {
  it("#ifdef / #else 两个分支的成员并集提取", async () => {
    const doc = await parseText(
      "cpp",
      "Conn.h",
      `
class Conn {
public:
  /** 通用方法 */
  void common();
#ifdef USE_SSL
  void connectSsl();
#else
  void connectPlain();
#endif
private:
  /** 套接字 */
  int m_fd;
};
`,
    );
    expect(names(doc.methods)).toEqual(["common", "connectSsl", "connectPlain"]);
    expect(names(doc.fields)).toEqual(["m_fd"]);
  });
});

describe("C++ 宏调用不被误判为方法", () => {
  it("函数式宏调用与构造声明 AST 同构：不同名不采信", async () => {
    const doc = await parseText(
      "cpp",
      "Bar.h",
      `
#define DECLARE_GETTER(type, name) type get##name() const
class Bar {
public:
  DECLARE_GETTER(int, Age)
private:
  /** 年龄 */
  int Age_;
};
`,
    );
    // DECLARE_GETTER(int, Age) 与 Bar(); 结构相同，但名称与类名不同 → 不收集
    expect(doc.methods).toHaveLength(0);
    expect(names(doc.fields)).toEqual(["Age_"]);
  });
});
