from hawkama_copilot.exporters.markdown_ast import (
    is_mermaid_block,
    looks_like_mermaid,
    parse_markdown,
)

MD = """# عنوان رئيسي

## قسم
فقرة أولى **مهمة**.

- بند أول
- بند ثانٍ

| العمود أ | العمود ب |
|---|---|
| 1 | 2 |
| 3 | 4 |

> اقتباس

```
code here
```
"""


def test_parse_blocks():
    blocks = parse_markdown(MD)
    kinds = [b.type for b in blocks]
    assert "heading" in kinds
    assert "paragraph" in kinds
    assert "bullet" in kinds
    assert "table" in kinds
    assert "quote" in kinds
    assert "code" in kinds


def test_table_structure():
    table = next(b for b in parse_markdown(MD) if b.type == "table")
    assert table.headers == ["العمود أ", "العمود ب"]
    assert table.rows == [["1", "2"], ["3", "4"]]


def test_inline_emphasis_stripped():
    para = next(b for b in parse_markdown(MD) if b.type == "paragraph")
    assert "**" not in para.text
    assert "مهمة" in para.text


def test_heading_levels():
    h1 = next(b for b in parse_markdown(MD) if b.type == "heading" and b.level == 1)
    assert h1.text == "عنوان رئيسي"


# --------------------------------------------------------------------------- #
# Mermaid detection (ported from services/mermaidDetect.ts)                    #
# --------------------------------------------------------------------------- #
MERMAID_MD = """مقدمة قصيرة.

```mermaid
graph TD
  A --> B
```

ثم نص آخر.

```graph TD
  X --> Y
```

وكتلة برمجية:

```python
def f():
    return 1
```
"""


def test_explicit_mermaid_fence_is_mermaid():
    blocks = parse_markdown(MERMAID_MD)
    mermaids = [b for b in blocks if b.type == "mermaid"]
    # both the ```mermaid fence and the bare ```graph TD fence
    assert len(mermaids) == 2
    assert mermaids[0].lang == "mermaid"
    assert "graph TD" in mermaids[0].text


def test_bare_graph_fence_sniffed_as_mermaid():
    blocks = parse_markdown(MERMAID_MD)
    bare = next(b for b in blocks if b.type == "mermaid" and "X --> Y" in b.text)
    assert bare.lang == "graph TD"


def test_python_fence_stays_code():
    blocks = parse_markdown(MERMAID_MD)
    code = [b for b in blocks if b.type == "code"]
    assert len(code) == 1
    assert code[0].lang == "python"
    assert "def f" in code[0].text
    # a real programming language is never sniffed as a diagram even if it began
    # with a Mermaid keyword
    assert not any(b.type == "mermaid" and b.lang == "python" for b in blocks)


def test_detection_helpers():
    assert is_mermaid_block("mermaid", "anything")
    assert is_mermaid_block("mmd", "anything")
    assert is_mermaid_block("", "flowchart LR\n A-->B")
    assert is_mermaid_block(None, "sequenceDiagram\n A->>B: hi")
    assert looks_like_mermaid("erDiagram\n A ||--o{ B : has")
    # programming languages are not sniffed
    assert not is_mermaid_block("python", "graph TD")
    assert not is_mermaid_block("js", "graph TD")
    # plain prose is not a diagram
    assert not looks_like_mermaid("this is just a sentence")
