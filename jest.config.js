/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  // vscode 模块映射到测试 mock（解析链路依赖 vscode API）
  moduleNameMapper: {
    "^vscode$": "<rootDir>/test/mocks/vscode.ts",
    // NodeNext 源码使用 "./xxx.js" 相对导入，映射回 .ts 源文件
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/test/tsconfig.json" }],
  },
};
