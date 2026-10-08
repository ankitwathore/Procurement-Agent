/**
 * The analyst's calculator (spec 14.2): the only place a derived number may come from. A small arithmetic parser,
 * never `eval`: numbers, named inputs, + - * / ^, parentheses, and min, max, abs, round, sum. Anything else is an error
 * the model can read and fix.
 */

export interface CalcResult {
  value: number;
  expression: string;
}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+(?:,\d+)*(?:\.\d+)?|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0].replace(/,/g, "")) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${c}" at position ${i}`);
  }
  return out;
}

const FUNCS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0] as number),
  round: (a) => {
    const f = 10 ** (a[1] ?? 0);
    return Math.round((a[0] as number) * f) / f;
  },
  sum: (a) => a.reduce((s, x) => s + x, 0),
};

export function calc(expression: string, inputs: Readonly<Record<string, number>> = {}): CalcResult {
  if (expression.length > 2000) throw new Error("expression too long");
  const toks = tokenize(expression);
  let p = 0;
  const peek = () => toks[p];
  const take = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`expected ${v ?? "a value"} at token ${p + 1}`);
    p++;
    return t;
  };
  const expr = (): number => {
    let v = term();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) v = take().v === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = take().v;
      const r = power();
      if (op === "/" && r === 0) throw new Error("division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (peek()?.t === "op" && peek()!.v === "^") {
      take();
      return b ** power();
    }
    return b;
  };
  const unary = (): number => {
    if (peek()?.t === "op" && peek()!.v === "-") {
      take();
      return -unary();
    }
    if (peek()?.t === "op" && peek()!.v === "+") {
      take();
      return unary();
    }
    return atom();
  };
  const atom = (): number => {
    const t = take();
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      take(")");
      return v;
    }
    if (t.t === "id") {
      if (peek()?.t === "op" && peek()!.v === "(") {
        const f = FUNCS[t.v.toLowerCase()];
        if (!f) throw new Error(`unknown function ${t.v}`);
        take("(");
        const args = [expr()];
        while (peek()?.t === "op" && peek()!.v === ",") {
          take();
          args.push(expr());
        }
        take(")");
        return f(args);
      }
      const v = inputs[t.v];
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`unknown input ${t.v}; pass it in inputs`);
      return v;
    }
    throw new Error(`unexpected "${t.v}"`);
  };
  const value = expr();
  if (p !== toks.length) throw new Error(`unexpected "${toks[p]!.v}" after the expression`);
  if (!Number.isFinite(value)) throw new Error("result is not a finite number");
  return { value, expression };
}
