from hawkama_copilot.exporters.markdown_ast import parse_markdown

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
