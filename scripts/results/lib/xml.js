'use strict';

// A deliberately tiny XML reader — enough for JUnit reports (elements, attributes, text, CDATA,
// self-closing tags, entities). Not a general XML parser: no namespaces, DTDs or validation.
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
});

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decode(m[2] !== undefined ? m[2] : m[3]);
  return attrs;
}

function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of String(src).matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      if (m[2] === '/') {
        // close: pop to the matching open element (tolerates mismatches rather than throwing)
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].name === m[3]) { stack.length = i; break; }
        }
      } else {
        const node = { name: m[3], attrs: parseAttrs(m[4] || ''), children: [], text: '' };
        top.children.push(node);
        if (m[5] !== '/') stack.push(node);
      }
    } else if (m[6] !== undefined) {
      top.text += decode(m[6]);
    }
  }
  return root;
}

module.exports = { parseXml, decode };
