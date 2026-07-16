const SOURCE_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'ltx',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html',
  'htm', 'py', 'sh', 'bash', 'yaml', 'yml', 'toml', 'sql',
])

const TEX_TOKEN_RE = /(%[^\n]*)|(\$(?:\\.|[^$\\])*\$)|(\\(?:[A-Za-z@]+|.))|\b(\d+(?:\.\d+)?)\b/g
const SOURCE_TOKEN_RE = /(<!--[\s\S]*?-->|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|from|as|export|default|const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|async|await|yield|typeof|instanceof|in|of|def|lambda|with|elif|fi|then|select|insert|update|delete|create|where|join|order|group|by)\b|\b(true|false|null|undefined|None|True|False)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)|(<\/?[A-Za-z][\w.-]*)/g

export function sourceKind(path) {
  const name = String(path || '').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return SOURCE_EXTENSIONS.has(ext) ? ext : ''
}

function genericTokenClass(match) {
  if (match[1]) return 'cm-syn-comment'
  if (match[2]) return 'cm-syn-string'
  if (match[3]) return 'cm-syn-keyword'
  if (match[4]) return 'cm-syn-literal'
  if (match[5]) return 'cm-syn-number'
  return 'cm-syn-tag'
}

export function sourceTokens(path, text) {
  const kind = sourceKind(path)
  if (!kind) return []
  const tokens = []
  const source = String(text || '')
  const isTex = ['tex', 'bib', 'sty', 'cls', 'ltx'].includes(kind)
  const pattern = isTex ? TEX_TOKEN_RE : SOURCE_TOKEN_RE
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(source))) {
    let className
    if (isTex) {
      if (match[1]) className = 'cm-syn-comment'
      else if (match[2]) className = 'cm-syn-string'
      else if (match[3]) className = 'cm-syn-command'
      else className = 'cm-syn-number'
    } else {
      className = genericTokenClass(match)
    }
    tokens.push({ from: match.index, to: match.index + match[0].length, className })
  }
  return tokens
}
