// PHP's built-in server sends Connection: close. An unread fetch body pauses undici, and
// Parser.finish then throws assert(!this.paused). That broke agent-pay (f935537) and the
// WordPress counter test (e6fb4a6). Reading .status or .ok does not read the body.
// json, text, arrayBuffer, blob, and formData do.

const BODY = "(?:json|text|arrayBuffer|blob|formData)";

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** Index of the `)` that closes the `(` at `open`. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
    }
  }
  return -1;
}

/**
 * @param {string} src
 * @returns {{ line: number, text: string }[]}
 */
export function unreadFetches(src) {
  const code = stripComments(src);
  const hits = [];
  const re = /fetch\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf("(", m.index);
    const close = closeParen(code, open);
    if (close < 0) continue;
    const line = lineOf(code, m.index);
    const text = code.split("\n")[line - 1].trim();
    let i = close + 1;
    while (code[i] === ")" || code[i] === " ") i++;
    const member = new RegExp(String.raw`^\.\s*(${BODY}|status|ok)\b`).exec(code.slice(i));
    if (member) {
      const wrapped = /(?:drain|body)\(\s*(?:await\s+)?$/.test(code.slice(Math.max(0, m.index - 40), m.index));
      if ((member[1] === "status" || member[1] === "ok") && !wrapped) hits.push({ line, text });
      continue;
    }
    const before = code.slice(Math.max(0, m.index - 160), m.index);
    const assigned = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:[\w$.]+\.)?$/.exec(before);
    if (!assigned) continue;
    const name = assigned[1];
    const from = m.index;
    const rest = code.slice(from);
    const nextAssign = rest.slice(1).search(new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=`));
    const span = nextAssign < 0 ? rest : rest.slice(0, nextAssign + 1);
    const body = new RegExp(String.raw`\b${name}\s*(?:\.response\s*)?\.\s*${BODY}\s*\(|\b(?:body|drain)\(\s*${name}(?:\.response)?\s*\)`);
    const status = new RegExp(String.raw`\b${name}\s*(?:\.response\s*)?\.\s*(?:status|ok)\b`);
    const ternaryDrop = new RegExp(String.raw`\b${name}\.status\b[\s\S]{0,80}?\?\s*(?:await\s+)?${name}\.${BODY}\(`);
    // status/ok does not read the body. `body(response)` is the text reader in the load-pricing test.
    if (ternaryDrop.test(span) || (status.test(span) && !body.test(span))) hits.push({ line, text });
  }
  return hits;
}
