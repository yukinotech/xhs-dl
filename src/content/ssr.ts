import { parseExpressionAt, type Node } from "acorn";
import { AppError, protocolError } from "../domain/errors.js";
import { obj, pick } from "./normalize.js";
type Expression = Node & Record<string, unknown>;
// Decode a literal expression, never evaluate JavaScript supplied by a page.
function literal(raw: Node, depth = 0): unknown {
  if (depth > 100) throw protocolError("页面状态嵌套过深。");
  const x = raw as Expression;
  if (x.type === "Literal") return x.value;
  if (x.type === "Identifier" && x.name === "undefined") return null;
  if (
    x.type === "UnaryExpression" &&
    x.operator === "-" &&
    (x.argument as Node).type === "Literal"
  )
    return -Number(literal(x.argument as Node, depth + 1));
  if (x.type === "ArrayExpression")
    return (x.elements as Array<Node | null>).map((v) =>
      v ? literal(v, depth + 1) : null,
    );
  if (x.type === "ObjectExpression") {
    const result: Record<string, unknown> = Object.create(null);
    for (const prop of x.properties as Expression[]) {
      if (
        prop.type !== "Property" ||
        prop.kind !== "init" ||
        prop.computed ||
        prop.method
      )
        throw protocolError("页面状态包含非静态对象。");
      const key = prop.key as Expression;
      const name =
        key.type === "Identifier" ? String(key.name) : String(key.value);
      if (["__proto__", "constructor", "prototype"].includes(name)) continue;
      result[name] = literal(prop.value as Node, depth + 1);
    }
    return result;
  }
  throw protocolError("页面状态包含非静态表达式，已拒绝执行。");
}
export function noteFromHtml(html: string, id: string) {
  const match = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!match)
    throw new AppError(
      "CONTENT_UNAVAILABLE",
      "页面没有可读取的结构化详情。",
      7,
    );
  let root: unknown;
  try {
    root = literal(
      parseExpressionAt(html, match.index + match[0].length, {
        ecmaVersion: "latest",
      }),
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw protocolError("无法静态解析页面详情。");
  }
  const map = obj(obj(obj(root).note).noteDetailMap),
    entry = obj(map[id]);
  const note = pick(entry, "note", "noteDetail");
  if (!note)
    throw new AppError("CONTENT_UNAVAILABLE", "页面没有对应帖子详情。", 7);
  return note;
}
