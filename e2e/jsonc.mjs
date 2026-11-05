/** JSON with comments, leaving anything inside a string alone. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += text[i];
  }
  return JSON.parse(out);
}
