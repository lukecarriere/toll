// cashuA was refused twice (#20 bbeb17c, #21 5ef8dbd). abort() deleted proofs the mint
// still held (#22). Each abort() is allowed when an empty restore and an all-UNSPENT
// check already guard it. How many calls there are does not matter. lose() does not.
// Node and TypeScript are parsed with the TypeScript compiler. PHP is not.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface GuardHit {
  file: string;
  line: number;
  rule: string;
}

const ROOT = new URL("..", import.meta.url).pathname;
const BONLY = "cashuB-only gate";
const AREF = "cashuA is not a payment";
const UNGATED = "abort() is not gated on an empty restore and an unspent check";
const LOSE = "lose() drops outputs the mint may hold";

/** A cashuB prefix check inside these functions is the V4 decoder or the test mint. */
const V4_ONLY: Readonly<Record<string, ReadonlySet<string>>> = {
  "packages/settlement-ln/src/cashu.ts": new Set(["decodeTokenV3", "decodeTokenV4"]),
  "packages/agent/src/index.ts": new Set(["testMintPayer"]),
};

type Class = "bonly" | "a" | "both" | null;
type Facts = { empty: boolean; unspent: boolean };
type Info = { empty: boolean; unspent: boolean; notNone: boolean; blocks: boolean };
const NONE: Info = { empty: false, unspent: false, notNone: false, blocks: false };

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

function fnName(node: ts.Node): string {
  let n: ts.Node | undefined = node;
  while (n) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    n = n.parent;
  }
  return "";
}

function lineAt(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function strArg(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const n = unwrap(e);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

function kindAccess(e: ts.Expression): boolean {
  e = unwrap(e);
  if (ts.isPropertyAccessExpression(e) || ts.isPropertyAccessChain(e)) return e.name.text === "kind";
  if (ts.isElementAccessExpression(e) && e.argumentExpression && strArg(e.argumentExpression) === "kind") return true;
  return false;
}

function callName(expr: ts.Expression): string | null {
  expr = unwrap(expr);
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && expr.argumentExpression) return strArg(expr.argumentExpression);
  return null;
}

function calleeObj(expr: ts.Expression): ts.Expression | null {
  expr = unwrap(expr);
  if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr) || ts.isElementAccessExpression(expr)) return expr.expression;
  return null;
}

function reText(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const n = unwrap(e);
  return ts.isRegularExpressionLiteral(n) ? n.text : null;
}

function prefixClass(p: string | null, neg = false): Class {
  if (p === "cashuB") return "bonly";
  if (p === "cashuA") return neg ? "bonly" : "a";
  return null;
}

function reClass(re: string | null, neg = false): Class {
  if (!re) return null;
  if (/^\/\^cashuB/.test(re)) return "bonly";
  if (/^\/\^cashuA/.test(re)) return neg ? "bonly" : "a";
  return null;
}

function firstElem(e: ts.Expression | undefined): ts.Expression | undefined {
  if (!e) return undefined;
  const n = unwrap(e);
  if (!ts.isArrayLiteralExpression(n) || n.elements.length === 0) return undefined;
  const el = n.elements[0];
  return el && ts.isExpression(el) ? el : undefined;
}

/** startsWith, match, test, and String.prototype.startsWith.call / apply. */
function callClass(e: ts.CallExpression): Class {
  const name = callName(e.expression);
  const obj = calleeObj(e.expression);
  if ((name === "call" || name === "apply") && obj && callName(obj) === "startsWith") {
    const arg = name === "call" ? e.arguments[1] : firstElem(e.arguments[1]);
    return prefixClass(strArg(arg));
  }
  if (name === "startsWith") return prefixClass(strArg(e.arguments[0]));
  if (name === "match") return reClass(reText(e.arguments[0]));
  if (name === "test" && obj) return reClass(reText(obj));
  return null;
}

function atomic(e: ts.Expression): Class {
  if (ts.isCallExpression(e)) {
    const c = callClass(e);
    if (c) return c;
  }
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!eq && !ne) return null;
  const left = unwrap(e.left);
  const right = unwrap(e.right);
  if (kindAccess(left) && strArg(right) === "a") return eq ? "a" : null;
  if (kindAccess(right) && strArg(left) === "a") return eq ? "a" : null;
  if (ts.isCallExpression(left) && callClass(left)) {
    const rightNull = right.kind === ts.SyntaxKind.NullKeyword;
    if (rightNull) return callClass(left) === "a" && ne ? "a" : "bonly";
  }
  if (ts.isCallExpression(left) && (ts.isPropertyAccessExpression(left.expression) || ts.isPropertyAccessChain(left.expression))) {
    const name = left.expression.name.text;
    if (name === "indexOf" && ts.isNumericLiteral(right) && right.text === "0") {
      const p = strArg(left.arguments[0]);
      if (p === "cashuB" || (p === "cashuA" && ne)) return "bonly";
      if (p === "cashuA") return "a";
    }
    if (name === "slice" || name === "substring" || name === "substr") {
      const p = strArg(right);
      if (p === "cashuB") return "bonly";
      if (p === "cashuA") return ne ? "bonly" : "a";
    }
  }
  return null;
}

function classify(e: ts.Expression): Class {
  e = unwrap(e);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const i = classify(e.operand);
    if (i === "a" || i === "bonly") return "bonly";
    return null;
  }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const or = e.operatorToken.kind === ts.SyntaxKind.BarBarToken;
    const l = classify(e.left);
    const r = classify(e.right);
    if (l === "both" || r === "both") return "both";
    if (or && ((l === "a" && r === "bonly") || (l === "bonly" && r === "a"))) return "both";
    if (l === "bonly" || r === "bonly") return "bonly";
    if (l === "a" || r === "a") return "a";
    return null;
  }
  return atomic(e);
}

function refuses(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isBlock(node)) return node.statements.some(refuses);
  if (ts.isThrowStatement(node)) return true;
  if (!ts.isReturnStatement(node) && !ts.isExpressionStatement(node)) return false;
  const expr = ts.isReturnStatement(node) ? node.expression : node.expression;
  if (!expr) return true;
  const n = unwrap(expr);
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isObjectLiteralExpression(n)) {
    const hasToken = n.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "token");
    return !hasToken || n.getText().includes("malformed");
  }
  return false;
}

function tokenScan(sf: ts.SourceFile, file: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const exempt = (n: ts.Node) => V4_ONLY[file]?.has(fnName(n)) ?? false;
  const note = (node: ts.Node, rule: string) => hits.push({ file, line: lineAt(sf, node), rule });
  const rec = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const c = classify(node.expression);
      if (c === "bonly" && !exempt(node)) note(node, BONLY);
      if (c === "a" && refuses(node.thenStatement)) note(node, AREF);
    } else if (ts.isConditionalExpression(node)) {
      const c = classify(node.condition);
      if (c === "bonly" && !exempt(node)) note(node, BONLY);
      if (c === "a" && refusesExpr(node.whenTrue)) note(node, AREF);
    } else if (ts.isSwitchStatement(node) && !exempt(node)) {
      let hasA = false;
      let hasB = false;
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const label = strArg(clause.expression);
        if (label === "cashuA") hasA = true;
        if (label === "cashuB") hasB = true;
      }
      if (hasB && !hasA) note(node, BONLY);
      if (hasA && !hasB) note(node, AREF);
    }
    ts.forEachChild(node, rec);
  };
  rec(sf);
  return hits;
}

function refusesExpr(e: ts.Expression): boolean {
  const n = unwrap(e);
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isObjectLiteralExpression(n)) return !n.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "token");
  return false;
}

function exprInfo(e: ts.Expression, alias: Map<string, Info>): Info {
  e = unwrap(e);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const i = exprInfo(e.operand, alias);
    if (i.blocks) return NONE;
    if (i.empty) return { empty: false, unspent: i.unspent, notNone: true, blocks: false };
    return NONE;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const l = exprInfo(e.left, alias);
    const r = exprInfo(e.right, alias);
    const blocks = l.blocks || r.blocks;
    return { empty: !blocks && (l.empty || r.empty), unspent: l.unspent || r.unspent, notNone: false, blocks };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const l = exprInfo(e.left, alias);
    const r = exprInfo(e.right, alias);
    return { empty: (l.empty || r.empty) && !l.blocks && !r.blocks, unspent: l.unspent && r.unspent, notNone: l.notNone && r.notNone, blocks: l.blocks || r.blocks };
  }
  if (ts.isIdentifier(e)) {
    const known = alias.get(e.text);
    if (known) return known;
    if (e.text === "empty") return { empty: true, unspent: false, notNone: false, blocks: false };
    if (e.text === "unclear") return { empty: false, unspent: false, notNone: false, blocks: true };
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    const sides = [unwrap(e.left), unwrap(e.right)];
    const lit = sides.find((s) => ts.isStringLiteral(s));
    const other = sides.find((s) => s !== lit);
    if (lit && ts.isStringLiteral(lit) && other) {
      if (lit.text === "none" && kindAccess(other)) return eq ? { empty: true, unspent: false, notNone: false, blocks: false } : ne ? { empty: false, unspent: false, notNone: true, blocks: false } : NONE;
      if (lit.text.toLowerCase() === "unspent" && eq) return { empty: false, unspent: true, notNone: false, blocks: false };
    }
  }
  return NONE;
}

function boundAbort(e: ts.Expression): boolean {
  e = unwrap(e);
  if (!ts.isCallExpression(e) || !(ts.isPropertyAccessExpression(e.expression) || ts.isPropertyAccessChain(e.expression)) || e.expression.name.text !== "bind") return false;
  const inner = e.expression.expression;
  return (ts.isPropertyAccessExpression(inner) || ts.isPropertyAccessChain(inner)) && inner.name.text === "abort";
}

function fnBody(n: ts.Node): ts.Block | ts.Expression | undefined {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n.body;
  return undefined;
}

function prop(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e) || ts.isPropertyAccessChain(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && e.argumentExpression) return strArg(e.argumentExpression);
  return null;
}

/** abort() and lose() calls. Zero-arg abort() is AbortController, not the proof store. */
export function conservationHits(text: string, file = "packages/settlement-ln/src/cashu-receive.ts"): GuardHit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: GuardHit[] = [];
  const walkFns = (node: ts.Node, flow: Facts, bound: Set<string>) => {
    const callOf = (c: ts.CallExpression, scope: Set<string>): "abort" | "lose" | null => {
      if (ts.isIdentifier(c.expression) && scope.has(c.expression.text) && c.arguments.length > 0) return "abort";
      if (ts.isCallExpression(c.expression) && boundAbort(c.expression) && c.arguments.length > 0) return "abort";
      const name = prop(c.expression);
      if (name === "apply" && calleeObj(c.expression) && prop(calleeObj(c.expression)!) === "abort") return "abort";
      if (name === "lose") return "lose";
      if (name === "abort" && c.arguments.length > 0) return "abort";
      return null;
    };
    const find = (n: ts.Node, facts: Facts, scope: Set<string>, alias: Map<string, Info>) => {
      const nested = fnBody(n);
      if (nested && n !== node) {
        const next = new Set(scope);
        stmts(ts.isBlock(nested) ? nested.statements : [ts.factory.createExpressionStatement(nested)], facts, next, alias);
        return;
      }
      if (ts.isCallExpression(n)) {
        const k = callOf(n, scope);
        if (k === "lose") hits.push({ file, line: lineAt(sf, n), rule: LOSE });
        if (k === "abort" && !(facts.empty && facts.unspent)) hits.push({ file, line: lineAt(sf, n), rule: UNGATED });
      }
      ts.forEachChild(n, (c) => find(c, facts, scope, alias));
    };
    const skips = (s: ts.Statement | undefined): boolean => {
      if (!s) return false;
      if (ts.isBlock(s)) return s.statements.length === 1 && skips(s.statements[0]);
      return ts.isContinueStatement(s) || ts.isReturnStatement(s) || ts.isBreakStatement(s) || ts.isThrowStatement(s);
    };
    const stmts = (list: readonly ts.Statement[], facts: Facts, scope: Set<string>, alias: Map<string, Info>) => {
      let flowNow = facts;
      for (const s of list) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            if (boundAbort(d.initializer)) scope.add(d.name.text);
            const info = exprInfo(d.initializer, alias);
            if (info.empty || info.unspent || info.blocks || info.notNone) alias.set(d.name.text, info);
          }
        }
        if (ts.isIfStatement(s)) {
          const info = exprInfo(s.expression, alias);
          if (skips(s.thenStatement) && info.notNone) {
            if (s.elseStatement) stmts(ts.isBlock(s.elseStatement) ? s.elseStatement.statements : [s.elseStatement], flowNow, scope, alias);
            flowNow = { ...flowNow, empty: true };
          } else {
            const inner = { empty: !info.blocks && (flowNow.empty || info.empty), unspent: flowNow.unspent || info.unspent };
            stmts(ts.isBlock(s.thenStatement) ? s.thenStatement.statements : [s.thenStatement], inner, scope, alias);
            if (s.elseStatement) stmts(ts.isBlock(s.elseStatement) ? s.elseStatement.statements : [s.elseStatement], flowNow, scope, alias);
          }
          continue;
        }
        if ((ts.isForStatement(s) || ts.isForInStatement(s) || ts.isForOfStatement(s) || ts.isWhileStatement(s)) && s.statement) {
          stmts(ts.isBlock(s.statement) ? s.statement.statements : [s.statement], flowNow, scope, alias);
          continue;
        }
        if (ts.isTryStatement(s)) {
          stmts(s.tryBlock.statements, flowNow, scope, alias);
          if (s.catchClause) stmts(s.catchClause.block.statements, flowNow, scope, alias);
          continue;
        }
        if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) {
          enter(s, scope);
          continue;
        }
        find(s, flowNow, scope, alias);
      }
    };
    const enter = (n: ts.Node, scope: Set<string>) => {
      if (ts.isSourceFile(n)) {
        stmts(n.statements, { empty: false, unspent: false }, new Set(scope), new Map());
        return;
      }
      if (ts.isClassDeclaration(n)) {
        for (const m of n.members) enter(m, scope);
        return;
      }
      const body = fnBody(n);
      if (body && ts.isBlock(body)) stmts(body.statements, { empty: false, unspent: false }, new Set(scope), new Map());
    };
    enter(node, bound);
  };
  walkFns(sf, { empty: false, unspent: false }, new Set());
  return hits;
}

function blankPhp(text: string): string {
  const out = text.split("");
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === "\"") { q = c; continue; }
    if ((c === "/" && text[i + 1] === "/") || c === "#") {
      const skip = c === "#";
      if (!skip) out[i + 1] = " ";
      while (i < text.length && text[i] !== "\n") { out[i] = " "; i++; }
      i--;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < text.length) out[i] = " ";
      if (text[i + 1] === "/") out[i + 1] = " ";
    }
  }
  return out.join("");
}

function phpStmt(code: string, index: number): string {
  let s = index;
  while (s > 0 && code[s - 1] !== ";") s--;
  let e = index;
  while (e < code.length && code[e] !== ";") e++;
  return code.slice(s, e);
}

function phpHits(file: string, text: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const code = blankPhp(text);
  const re = /str_starts_with\s*\(\s*(\$\w+)\s*,\s*(['"])cashu([AB])\2\s*\)|substr\s*\(\s*(\$\w+)\s*,\s*0\s*,\s*6\s*\)\s*(===?|!==?)\s*(['"])cashu([AB])\6|strpos\s*\(\s*(\$\w+)\s*,\s*(['"])cashu([AB])\9\s*\)\s*(===?|!==?)\s*0|\[['"]kind['"]\]\s*===?\s*['"]a['"]|->kind\s*===?\s*['"]a['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const line = code.slice(0, m.index).split("\n").length;
    const stmt = phpStmt(code, m.index);
    const which = m[3] || m[7] || m[10];
    const who = m[1] || m[4] || m[8];
    const kindA = !which && (/\[['"]kind['"]\]\s*===?\s*['"]a['"]/.test(m[0]) || /->kind\s*===?\s*['"]a['"]/.test(m[0]));
    const negA = which === "A" && new RegExp(`!\\s*${m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(stmt);
    const stmtB = /str_starts_with\s*\(\s*\$\w+\s*,\s*['"]cashuB['"]/.test(stmt) || /substr\s*\(\s*\$\w+\s*,\s*0\s*,\s*6\s*\)\s*===?\s*['"]cashuB['"]/.test(stmt) || /strpos\s*\(\s*\$\w+\s*,\s*['"]cashuB['"]\s*\)\s*===?\s*0/.test(stmt);
    const stmtA = /str_starts_with\s*\(\s*\$\w+\s*,\s*['"]cashuA['"]/.test(stmt) && !/!\s*str_starts_with\s*\(\s*\$\w+\s*,\s*['"]cashuA['"]/.test(stmt);
    if (kindA && /malformed/.test(stmt)) hits.push({ file, line, rule: AREF });
    else if (stmtA && stmtB) { /* both prefixes pay */ }
    else if (which === "B" || negA) hits.push({ file, line, rule: BONLY });
    else if (which === "A" && who) {
      const esc = who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const forwards = stmt.includes(`'token' => ${who}`) || stmt.includes(`"token" => ${who}`) || new RegExp(`return\\s+${esc}\\b`).test(stmt);
      if (!forwards) hits.push({ file, line, rule: AREF });
    }
  }
  return hits;
}

/** Lines that accept only cashuB, or that refuse cashuA. `file` is the repo-relative path. */
export function tokenHits(file: string, text: string): GuardHit[] {
  if (file.endsWith(".php")) return phpHits(file, text);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return tokenScan(sf, file);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "dist" || name === ".git") continue;
    const abs = join(dir, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith(".ts") || name.endsWith(".php")) out.push(abs);
  }
  return out;
}

/** Hits under the repo. Empty on main. */
export function treeHits(root = ROOT): GuardHit[] {
  const hits: GuardHit[] = [];
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  for (const abs of walk(base)) {
    const file = abs.slice(base.length + 1);
    if (file.startsWith("scripts/cashu-guards")) continue;
    const text = readFileSync(abs, "utf8");
    hits.push(...tokenHits(file, text));
    if (file.endsWith(".ts")) hits.push(...conservationHits(text, file));
  }
  return hits;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const hits = treeHits();
  if (hits.length > 0) {
    for (const h of hits) console.error(`${h.file}:${h.line}: ${h.rule}`);
    console.error(`cashu-guards: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log("cashu-guards: 0 hits");
}
