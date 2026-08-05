import re
from pathlib import Path

def test_frontend_index_html_tag_balance():
    html_path = Path(__file__).resolve().parent.parent.parent / "frontend" / "index.html"
    content = html_path.read_text(encoding="utf-8")
    
    void_elements = {
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr'
    }
    
    tag_regex = re.compile(r'</?([a-zA-Z0-9-]+)(\s+[^>]*)?>')
    stack = []
    errors = []
    
    lines = content.split('\n')
    def get_pos_info(index):
        l = content.count('\n', 0, index) + 1
        last_nl = content.rfind('\n', 0, index)
        c = index - last_nl if last_nl != -1 else index + 1
        return l, c

    for match in tag_regex.finditer(content):
        full_tag = match.group(0)
        tag_name = match.group(1).lower()
        is_closing = full_tag.startswith('</')
        is_self_closing = full_tag.endswith('/>') or tag_name in void_elements
        
        pos = match.start()
        line, col = get_pos_info(pos)
        
        if is_self_closing and not is_closing:
            continue
            
        if not is_closing:
            stack.append((tag_name, line, col))
        else:
            if not stack:
                errors.append(f"Unmatched closing tag </{tag_name}> at L{line}:C{col}")
            else:
                top_name, top_line, top_col = stack.pop()
                if top_name != tag_name:
                    errors.append(f"Tag mismatch: expected </{top_name}> (opened at L{top_line}), found </{tag_name}> at L{line}:C{col}")
                    
    while stack:
        unclosed_name, unclosed_line, _ = stack.pop()
        errors.append(f"Unclosed tag <{unclosed_name}> opened at L{unclosed_line}")
        
    assert not errors, f"HTML tag balance errors found in index.html:\n" + "\n".join(errors)
