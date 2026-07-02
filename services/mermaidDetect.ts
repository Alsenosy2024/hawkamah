// ===========================================================================
//  mermaidDetect — recognize a Mermaid diagram from a fenced code block even
//  when the model tags the fence wrong or omits the language. Pure + tiny (no
//  mermaid import) so it can be used by the Markdown chat renderer WITHOUT
//  eagerly pulling the heavy mermaid runtime into that bundle.
//
//  Root cause it fixes: models often emit a diagram as ``` (no lang), ```flow,
//  ```graph, ```diagram, etc. — those fell through to a plain dark code block in
//  both the chat and the document canvas instead of rendering as a diagram.
// ===========================================================================

// First non-empty line of a Mermaid diagram starts with one of these keywords
// (optionally preceded by an %%{init}%% directive). Covers every Mermaid v11
// diagram type.
const MERMAID_HEAD = /^(?:%%\{[^}]*\}%%\s*)?(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie\b|journey|mindmap|timeline|quadrantChart|gitGraph|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|architecture(?:-beta)?|kanban|radar|zenuml|treemap)\b/i;

// Languages that are explicitly Mermaid (aliases the model might use).
const MERMAID_LANGS = new Set(['mermaid', 'mmd', 'mermaidjs']);

// Real programming/markup languages — never sniff their content as a diagram,
// even if it coincidentally starts with "graph" etc.
const PROG_LANGS = /^(js|javascript|ts|typescript|jsx|tsx|py|python|java|kotlin|c|cpp|c\+\+|cs|csharp|go|golang|rust|rs|rb|ruby|php|sh|bash|zsh|shell|console|sql|json|jsonc|yaml|yml|xml|html|htm|css|scss|sass|less|md|markdown|mdx|diff|patch|toml|ini|dockerfile|docker|swift|scala|r|matlab|perl|lua|dart|graphql|gql|proto|makefile|cmake|nginx|apache|vim|powershell|ps1|bat|tex|text|txt|plaintext|none)$/i;

/** True when the code body itself reads like a Mermaid diagram. */
export function looksLikeMermaid(code: string): boolean {
  return MERMAID_HEAD.test((code || '').trim());
}

/**
 * Decide whether a fenced code block should render as a Mermaid diagram.
 * - explicit mermaid language → yes
 * - a real programming language → no (don't sniff)
 * - empty/unknown/diagram-ish language → sniff the content
 */
export function isMermaidBlock(lang: string | undefined, code: string): boolean {
  const l = (lang || '').trim().toLowerCase();
  if (MERMAID_LANGS.has(l)) return true;
  if (l && PROG_LANGS.test(l)) return false;
  return looksLikeMermaid(code);
}

/**
 * Replace the FIRST fenced code block whose body matches `oldCode` exactly
 * (after trimming) with `newCode`, preserving that fence's language tag and
 * every other block/line untouched. No-op (returns `content` unchanged) when
 * no fence's body matches — never guesses or replaces a near-match.
 *
 * Powers GovCopilot's "edit a chat-rendered diagram" flow: an NL edit commits
 * a new Mermaid string, and this rewrites it back into the stored message
 * text at the same spot the ```mermaid fence originally rendered from.
 */
export function replaceMermaidFence(content: string, oldCode: string, newCode: string): string {
  const oldTrimmed = (oldCode || '').trim();
  if (!oldTrimmed) return content;
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[2].trim() === oldTrimmed) {
      const before = content.slice(0, m.index);
      const after = content.slice(m.index + m[0].length);
      return `${before}\`\`\`${m[1]}\n${(newCode || '').trim()}\n\`\`\`${after}`;
    }
  }
  return content;
}
