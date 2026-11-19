#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 NotionApp contributors.
"""Package the full fixed public tree plus explicitly reviewed additions.
Run only after the candidate is frozen. Never walk private runtime/dependency dirs.
"""
from pathlib import Path
import argparse,hashlib,io,json,tarfile,gzip

p=argparse.ArgumentParser();p.add_argument('output');args=p.parse_args()
root=Path(__file__).resolve().parents[1];output=Path(args.output).resolve()
assert not output.exists(),'Use a new artifact filename; do not overwrite a prior release'
base=json.loads((root/'UPSTREAM-FILES.json').read_text());original={x['path']:x for x in base['files']}
additions=[
 'UPSTREAM.md','UPSTREAM-FILES.json','MODIFICATIONS.md','tools/package-source.py',
 'apps/relay/test/notify-revocation.test.ts',
 'apps/relay/src/assistant/gpt-login.ts',
 'apps/relay/src/assistant/gpt-login-credentials.ts',
 'apps/relay/test/gpt-login.test.ts',
 'apps/relay/test/gpt-login-credentials.test.ts',
]
paths=sorted(set(original)|set(additions));records=[];contents={}
for name in paths:
 file=root/name
 assert file.is_file() and not file.is_symlink(),f'Missing preferred source or unexpected link: {name}'
 data=file.read_bytes();before=original.get(name)
 mode=0o755 if before and before['mode']=='100755' else 0o644
 digest=hashlib.sha256(data).hexdigest();contents[name]=(data,mode)
 records.append({'path':name,'bytes':len(data),'sha256':digest,'mode':oct(mode),
                 'modified_from_upstream':digest!=before['sha256'] if before else None})
manifest=json.dumps({'upstream_commit':base['commit'],'upstream_tag':base['tag'],
 'components':'Official upstream Android source; locally modified relay/host source as listed',
 'files':records},ensure_ascii=False,indent=2).encode()+b'\n'
output.parent.mkdir(parents=True,exist_ok=True)
with output.open('xb') as raw,gzip.GzipFile(fileobj=raw,filename='',mode='wb',mtime=0) as zipped,tarfile.open(fileobj=zipped,mode='w|') as archive:
 for name,(data,mode) in [*contents.items(),('CORRESPONDING-SOURCE.json',(manifest,0o644))]:
  info=tarfile.TarInfo('source/'+name);info.size=len(data);info.mode=mode
  info.mtime=info.uid=info.gid=0;info.uname=info.gname='';archive.addfile(info,io.BytesIO(data))
print(json.dumps({'source_files':len(records),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'bytes':output.stat().st_size}))
