import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.mjs";

const indexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const allowedModules = ["collections", "functools", "itertools", "math", "re", "statistics", "string"];
let pyodidePromise;

function normalizeOutput(value) {
  return value.replace(/\r\n/g, "\n").trim().split(/\s+/).filter(Boolean).join(" ");
}

self.onmessage = async ({ data }) => {
  try {
    const pyodide = await (pyodidePromise ||= loadPyodide({ indexURL }));
    self.postMessage({ type: "ready" });
    await new Promise(resolve => setTimeout(resolve, 0));

    const results = [];
    for (const testCase of data.testCases) {
      pyodide.globals.set("student_source", data.source);
      pyodide.globals.set("case_input", testCase.input);
      const resultProxy = pyodide.runPython(`
import ast
import builtins
import contextlib
import io

allowed_modules = ${JSON.stringify(allowedModules)}
tree = ast.parse(student_source)
for node in ast.walk(tree):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        names = [alias.name.split(".")[0] for alias in node.names] if isinstance(node, ast.Import) else [node.module.split(".")[0]]
        if any(name not in allowed_modules for name in names):
            raise ImportError("이 실행 환경에서 사용할 수 없는 모듈입니다.")
    if isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr == "format"):
        raise ValueError("보호된 파이썬 기능은 사용할 수 없습니다.")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"breakpoint", "compile", "eval", "exec", "getattr", "globals", "locals", "open", "setattr", "vars"}:
        raise ValueError("이 실행 환경에서 사용할 수 없는 함수입니다.")

input_lines = iter(case_input.splitlines())
def safe_input(prompt=""):
    try:
        return next(input_lines)
    except StopIteration:
        raise EOFError("입력 데이터가 부족합니다.")

class OutputLimitError(Exception):
    pass

class LimitedOutput(io.StringIO):
    def write(self, value):
        if self.tell() + len(value) > 10000:
            raise OutputLimitError("출력이 너무 깁니다.")
        return super().write(value)

safe_names = ${JSON.stringify(["abs", "all", "any", "bool", "chr", "dict", "divmod", "enumerate", "Exception", "filter", "float", "frozenset", "hex", "IndexError", "int", "isinstance", "iter", "KeyError", "len", "list", "map", "max", "min", "NameError", "next", "oct", "ord", "pow", "print", "range", "reversed", "round", "RuntimeError", "set", "slice", "sorted", "str", "sum", "tuple", "TypeError", "ValueError", "zip"])}
safe_builtins = {name: getattr(builtins, name) for name in safe_names}
safe_builtins["input"] = safe_input
def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name.split(".")[0] not in allowed_modules:
        raise ImportError("이 실행 환경에서 사용할 수 없는 모듈입니다.")
    return builtins.__import__(name, globals, locals, fromlist, level)
safe_builtins["__import__"] = safe_import
output = LimitedOutput()
namespace = {"__name__": "__main__", "__builtins__": safe_builtins}
try:
    with contextlib.redirect_stdout(output):
        exec(compile(student_source, "<student>", "exec"), namespace)
    answer = {"output": output.getvalue(), "error": None}
except Exception as error:
    answer = {"output": output.getvalue(), "error": type(error).__name__ + ": " + str(error)[:240]}
answer
`);
      const answer = resultProxy.toJs({ dict_converter: Object.fromEntries });
      resultProxy.destroy();
      const passed = !answer.error && normalizeOutput(answer.output) === normalizeOutput(testCase.expected);
      results.push({
        passed,
        output: answer.output,
        expected: testCase.expected,
        error: answer.error
      });
      pyodide.globals.delete("student_source");
      pyodide.globals.delete("case_input");
      if (answer.error) break;
    }

    const status = results.some(result => result.error)
      ? "runtime_error"
      : results.every(result => result.passed) ? "accepted" : "wrong_answer";
    self.postMessage({ type: "result", status, results, total: data.testCases.length });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message || error).slice(0, 300) });
  }
};
