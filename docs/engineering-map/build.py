#!/usr/bin/env python3
"""Build the self-contained offline HTML. Python stdlib only; no product build/tests."""
import json
import runpy
import re
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, unquote

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
ns = runpy.run_path(str(HERE / 'data.py'))
data = ns['DATA']
refs = {'roadmap.md', 'requirements.md', 'acceptance.md', 'engineering-map.md'}

def published_ref(ref):
    """Only link files/fragments actually in this cropped public tree. Never import missing contracts."""
    parsed = urlsplit(ref)
    assert not parsed.scheme and not parsed.netloc and not parsed.query
    path = unquote(parsed.path)
    assert path and not path.startswith('/') and '\\' not in path
    target = (DOCS / path).resolve()
    assert target.is_relative_to(DOCS.parent.resolve()) and '.git' not in target.parts
    if not target.is_file():
        return False
    if not parsed.fragment:
        return True
    if target.suffix != '.md':
        return False
    seen, anchors = Counter(), set()
    for line in target.read_text().splitlines():
        match = re.match(r'^#{1,6} +(.+?)\s*#*$', line)
        if not match:
            continue
        name = re.sub(r'[`*_~]', '', match.group(1)).lower()
        name = ''.join(c for c in name if unicodedata.category(c)[0] in 'LNM' or c in '_- ').replace(' ', '-')
        count = seen[name]
        seen[name] += 1
        anchors.add(name + (f'-{count}' if count else ''))
    return unquote(parsed.fragment) in anchors

nodes = {n['id']: n for n in data['nodes']}
assert len(nodes) == len(data['nodes']), 'duplicate node id'
for node in nodes.values():
    assert node['system'] in nodes
    if node.get('parent'):
        assert node['parent'] in nodes
    for aid in node['apis']:
        assert aid in data['apis'], (node['id'], aid)
    for ref in [*node['code'], *node['docs'], *(g['basis'] for g in node['gaps'])]:
        refs.add(ref)
for aid, api in data['apis'].items():
    assert api['to'] in nodes and api['from_'], aid
    assert all(nid in nodes for nid in api['from_']), aid
    assert api['receipt']
    refs.add(api['code'])
    if api['kind'] == 'proposal':
        assert api['method'] is None and api['path'] is None
for edge in data['edges']:
    assert edge['source'] in nodes and edge['target'] in nodes
    assert all(a in data['apis'] for a in edge['apis'])
for path in data['paths']:
    assert all(n in nodes and a in data['apis'] for n, a in path['steps'])
data['public_context'] = {
    'source_manifest_sha256': '10bea251aa4225ee60281b61a955a8611d465cefc24d94d06a4a2ca2484b58e4',
    'source_html_sha256': 'e3ebc4486b40dff8007d366a155fa72a934a6005ec3e8aa80903666544700675',
    'available_refs': sorted(ref for ref in refs if published_ref(ref)),
    'local_contract_refs': sorted(ref for ref in refs if not published_ref(ref)),
    'scope': 'Static capability/local-contract index only; file presence does not prove public implementation or verification. Missing contracts are not imported. Execution status remains local roadmap.'
}
text = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
template = (HERE / 'template.html').read_text()
assert template.count('__MAP_DATA__') == 1
output = DOCS / 'engineering-map.html'
output.write_text(template.replace('__MAP_DATA__', text))
print(f'Built {output.name}: {len(nodes)} nodes, {len(data["apis"])} unique contracts, {len(data["edges"])} dependencies, {output.stat().st_size} bytes')
