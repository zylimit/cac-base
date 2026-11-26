---
name: test-scaffold
description: 最小可用测试基建参考（Node 原生 node:test / Vitest / Python pytest），先跑通 1 条冒烟再补高价值契约测试。
---

# 测试基建最小 Scaffold 参考

> 原则：最小可用、零多余插件。零依赖 Node 项目优先使用内置 `node:test` + `node:assert/strict`（无需装任何 npm 包，Windows PowerShell 与 Linux 直接 `node --test` 运行）。

## 1. 纯 Node 内置测试运行器（Node >= 20 零依赖首选）

- **目录约定**：`tests/*.test.mjs`（文件头标 `// risk: high|medium|low`）
- **最小样例**：
```js
// risk: low
import test from 'node:test';
import assert from 'node:assert/strict';

test('scaffold alive', () => {
  assert.equal(1 + 1, 2);
});
```
- **运行命令**：`node --test tests/*.test.mjs`

## 2. 前端 / TypeScript（Vitest）

- **依赖**：`vitest`（组件 DOM 测试再按需加 `jsdom` + `@testing-library/react`）
- **配置（`vitest.config.ts`）**：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node' },
});
```
- **运行命令**：`npx vitest run`

## 3. Python 后端（pytest）

- **依赖**：`pytest`（异步接口按需加 `pytest-asyncio`）
- **目录与配置（`pytest.ini`）**：
```ini
[pytest]
testpaths = tests
```
- **最小样例（`tests/test_smoke.py`）**：
```python
# risk: low
def test_scaffold_alive():
    assert 1 + 1 == 2
```
- **运行命令**：`python -m pytest -q`
