import { parseExpressionAt } from 'acorn';

/** Decode Nuxt's literal table without evaluating source code or calling any function. */
export function parseStaticState(html: string): Record<string, any> {
  const source = html.match(/window\.__NUXT__=([\s\S]*?);<\/script>/)?.[1];
  if (!source || source.length > 4_000_000) throw new Error('官方頁面缺少可解析的靜態資料');
  const root: any = parseExpressionAt(source, 0, { ecmaVersion: 2020 });
  let remaining = 150_000;
  const read = (node: any, vars = new Map<string, unknown>(), depth = 0): any => {
    if (!node || --remaining < 0 || depth > 60) throw new Error('靜態資料超過解析限制');
    const next = (n: any) => read(n, vars, depth + 1);
    if (node.type === 'Literal' && !node.regex && !node.bigint) return node.value;
    if (node.type === 'Identifier' && vars.has(node.name)) return vars.get(node.name);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Array' && node.arguments.length === 1 && node.arguments[0].type === 'Literal') {
      const length = node.arguments[0].value;
      if (Number.isInteger(length) && length >= 0 && length <= 10000) return new Array(length);
    }
    if (node.type === 'ArrayExpression') return node.elements.map(next);
    if (node.type === 'ObjectExpression') {
      const result = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method) throw new Error('非靜態屬性');
        const key = property.key.name ?? property.key.value;
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('不允許的屬性');
        result[key] = next(property.value);
      }
      return result;
    }
    if (node.type === 'UnaryExpression') {
      const value = next(node.argument);
      if (node.operator === '-' && typeof value === 'number') return -value;
      if (node.operator === '!') return !value;
      if (node.operator === 'void') return undefined;
    }
    throw new Error('官方頁面含非靜態運算，未執行');
  };
  if (root.type !== 'CallExpression' || root.callee.type !== 'FunctionExpression' || root.callee.body.body.at(-1)?.type !== 'ReturnStatement') throw new Error('不支援的靜態資料格式');
  const values = root.arguments.map((argument: any) => read(argument));
  if (root.callee.params.some((p: any) => p.type !== 'Identifier') || values.length !== root.callee.params.length) throw new Error('靜態參數格式不符');
  const vars = new Map<string, unknown>(root.callee.params.map((p: any, i: number) => [p.name, values[i]]));
  for (const statement of root.callee.body.body.slice(0, -1)) {
    const expr = statement.expression, left = expr?.left;
    if (statement.type !== 'ExpressionStatement' || expr.type !== 'AssignmentExpression' || expr.operator !== '=' || left.type !== 'MemberExpression' || left.object.type !== 'Identifier') throw new Error('非靜態資料指派');
    const target = vars.get(left.object.name) as any;
    const key = left.computed ? read(left.property, vars) : left.property.name;
    if (!target || typeof target !== 'object' || !['string', 'number'].includes(typeof key) || ['__proto__', 'prototype', 'constructor', 'length'].includes(String(key))) throw new Error('不允許的靜態指派');
    if (Array.isArray(target) && (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) > 10000)) throw new Error('無效陣列位置');
    target[key] = read(expr.right, vars);
  }
  return read(root.callee.body.body.at(-1).argument, vars);
}
