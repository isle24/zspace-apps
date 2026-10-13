#!/usr/bin/env python3
"""Generate reviewed fnOS drafts and atomic PostgreSQL import SQL; no DB writes.

Requires PyYAML on the build workstation only. Outputs preserve GPLv3 source
attribution. All records remain unpublished until normal administrative review.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import shutil
import sys
import urllib.parse

import yaml

PINNED_COMMIT='d297f9ac155b15a26b92632ee045ff4d530e2571'
SOURCE_REPOSITORY='https://github.com/conversun/fnos-apps'
EXISTING_IDS=['immich','jellyfin','memos','nasreader','navidrome','syncthing','uptime-kuma']
SENSITIVE=re.compile(r'password|passwd|(?:^|_)pass(?:$|_)|secret|token|private.?key|api.?key|credential|authorization|encrypt.*key|setup.?key|app.?key|access.?code',re.I)
PROTECTED=('/proc','/sys','/dev','/run','/var/run','/etc','/bin','/sbin','/usr')
BLOCKING_KEYS={'privileged','devices','cap_add','pid','network_mode','shm_size','entrypoint','command','user',
               'working_dir','sysctls','ulimits','hostname','init','security_opt','stop_grace_period','healthcheck'}
REPRESENTABLE_KEYS={'image','container_name','ports','volumes','environment','restart','pull_policy'}


def app_id(slug):
    if not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}',slug):raise ValueError('invalid source slug')
    result=slug if slug[0].isalpha() else 'fnos-'+slug
    if len(result)>64:raise ValueError('normalized application ID too long')
    return result


def image_reference(raw,version):
    if not isinstance(raw,str):return ''
    result=raw.replace('${DOCKER_MIRROR}','').replace('${VERSION}',version)
    # Source build scripts only use this integer substitution for major tags.
    result=result.replace('${VERSION_MAJOR}',version.split('.')[0])
    if ('$' in result or '://' in result or any(c.isspace() for c in result)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,999}',result)):
        return ''
    return result


def environments(value):
    if value is None:return {}
    if isinstance(value,dict):return value
    if isinstance(value,list):return {str(v).split('=',1)[0]:str(v).split('=',1)[1] if '=' in str(v) else None for v in value}
    raise ValueError('unsupported source environment shape')


def redact_source(value,key=''):
    if SENSITIVE.search(key):return '<redacted-source-parameter>'
    if isinstance(value,dict):return {str(k):redact_source(v,str(k)) for k,v in value.items()}
    if isinstance(value,list):
        result=[]
        for v in value:
            if key=='environment' and isinstance(v,str) and '=' in v:
                name,content=v.split('=',1);result.append(name+'='+str(redact_source(content,name)))
            else:result.append(redact_source(v,key))
        return result
    if isinstance(value,str):
        if key in ('command','entrypoint') and SENSITIVE.search(value):return '<redacted-command; inspect pinned source>'
        # Connection URLs can embed a password under otherwise neutral keys.
        if re.search(r'[a-z]+://[^\s/@:]+:[^\s/@]+@',value,re.I):return '<redacted-source-connection>'
    return value


def category(app):
    slug=app['slug']
    if slug in {'navidrome','koel','lyranest','melody-hub','songloft','audiobookshelf'}:return 'music'
    if slug in {'immich','photoprism','ente','niupic','lyranest'}:return 'photos'
    if slug in {'komga','kavita','calibre-web','lanraragi','koodo-reader','suwayomi'}:return 'reading'
    if app.get('category')=='media':return 'video'
    if slug in {'syncthing','rclone','openlist','alist','copyparty','cloudreve','nextcloud','seafile'}:return 'sync'
    if slug in {'uptime-kuma','beszel','glances','grafana','prometheus','netdata','fnmonitor'}:return 'monitoring'
    return 'tools'


def convert_app(app,source_root):
    slug=app['slug'];ident=app_id(slug);folder=source_root/'apps'/slug/'fnos'
    source_url=f'{SOURCE_REPOSITORY}/tree/{PINNED_COMMIT}/apps/{slug}'
    icon=app.get('icon_url','').replace('/main/',f'/{PINNED_COMMIT}/')
    draft={'id':ident,'name':app.get('display_name') or slug,'description':'','category':category(app),
           'icon':icon,'image':'','version':str(app.get('version') or '0.0.0'),'containerPort':0,
           'dataTargets':[],'environment':[],'published':False,'releaseNumber':0}
    provenance={'sourceSlug':slug,'applicationId':ident,'sourceRepository':SOURCE_REPOSITORY,
                'sourceCommit':PINNED_COMMIT,'sourceURL':source_url,'sourceType':app.get('app_type'),
                'sourceCategory':app.get('category'),'platforms':app.get('platforms',[]),
                'fpkVersion':app.get('fpk_version'),'releaseTag':app.get('release_tag'),
                'homepage':app.get('homepage_url'),'license':'GPL-3.0','blockers':[], 'images':[]}
    if app.get('app_type')!='docker':
        provenance['status']='native-pending';provenance['blockers']=['原生 FPK，需要独立平台适配，未提供 Docker 镜像']
        note='fnOS 原生 FPK · 待适配，不可作为 Docker 应用安装'
    else:
        compose_path=folder/'docker/docker-compose.yaml'
        if not compose_path.is_file():raise ValueError('missing Docker source: '+slug)
        raw=compose_path.read_bytes();compose=yaml.safe_load(raw)
        if not isinstance(compose,dict) or not isinstance(compose.get('services'),dict) or not compose['services']:
            raise ValueError('invalid Docker source: '+slug)
        provenance['compose']=redact_source(compose)
        provenance['composePath']=str(compose_path.relative_to(source_root))
        provenance['composeSHA256']=hashlib.sha256(raw).hexdigest()
        services=compose['services'];reasons=provenance['blockers']
        provenance['images']=[{'service':name,'sourceImage':str(service.get('image','')),
                              'resolvedImage':image_reference(service.get('image'),draft['version'])} for name,service in services.items()]
        if len(services)!=1:reasons.append(f'原定义有 {len(services)} 个服务，必须保留完整依赖模板')
        targets=[];environment=[];container_port=0
        for name,service in services.items():
            if not isinstance(service,dict):raise ValueError('invalid service source: '+slug)
            for key in service:
                if key in BLOCKING_KEYS and service[key] not in (None,False,[],{}):reasons.append('需要原运行设置 '+key)
                elif key not in REPRESENTABLE_KEYS|BLOCKING_KEYS:reasons.append('现单服务草稿不能完整表达 '+key)
            if service.get('depends_on'):reasons.append('存在服务启动依赖')
            if not image_reference(service.get('image'),draft['version']):reasons.append('镜像引用仍有未解析变量或非公开格式')
            ports=service.get('ports') or []
            if len(ports)!=1:reasons.append('需要完整端口定义，不能只取其中一个端口')
            else:
                port=ports[0]
                if isinstance(port,dict):target=port.get('target');protocol=port.get('protocol','tcp')
                else:
                    value=str(port);protocol=value.rsplit('/',1)[1] if '/' in value else 'tcp'
                    target=value.split('/')[0].rsplit(':',1)[-1]
                if str(target).isdigit() and 1<=int(target)<=65535 and protocol=='tcp':container_port=int(target)
                else:reasons.append('端口目标或协议不能表达为单个 TCP 入口')
            for volume in service.get('volumes') or []:
                if isinstance(volume,dict):
                    src=str(volume.get('source',''));target=str(volume.get('target',''));read_only=volume.get('read_only',False)
                else:
                    match=re.fullmatch(r'(.+):(/[^:]+)(?::(ro|rw))?',str(volume))
                    if not match:reasons.append('挂载格式需要完整适配');continue
                    src,target,mode=match.groups();read_only=mode=='ro'
                safe_src=bool(re.fullmatch(r'\$\{TRIM_PKGVAR(?::\?)?\}/[A-Za-z0-9_./-]+',src))
                named=compose.get('volumes',{}).get(src) if isinstance(compose.get('volumes'),dict) else None
                if src in (compose.get('volumes') or {}) and named in (None,{}):safe_src=True
                if not safe_src:reasons.append('挂载依赖外部目录、socket、变量或种子文件')
                if read_only:reasons.append('需要保留只读挂载语义')
                if (not target.startswith('/') or target=='/' or '..' in pathlib.PurePosixPath(target).parts
                        or any(target==p or target.startswith(p+'/') for p in PROTECTED)):
                    reasons.append('挂载目标超出现受限模板允许范围')
                if safe_src and src.startswith('${TRIM_PKGVAR'):
                    suffix=src.split('}/',1)[1];seed=folder/'var'/suffix
                    if seed.exists() and (seed.is_file() or any(seed.rglob('*'))):reasons.append('应用数据目录需要原包种子内容')
                targets.append(target)
            for key,value in environments(service.get('environment')).items():
                if not re.fullmatch('[A-Z][A-Z0-9_]{0,63}',key):reasons.append('环境变量名称需要适配');continue
                secret=bool(SENSITIVE.search(key))
                row={'name':key,'label':key,'secret':secret}
                if not secret:
                    literal='' if value is None else ('true' if value is True else 'false' if value is False else str(value))
                    if '$' in literal or len(literal)>256 or '\n' in literal or '\r' in literal:
                        reasons.append('依赖 fnOS 向导环境变量 '+key)
                    elif re.search(r'[a-z]+://[^\s/@:]+:[^\s/@]+@',literal,re.I):
                        reasons.append('连接参数含凭据，需要秘密参数适配')
                    else:row['default']=literal
                environment.append(row)
        if len(targets)>16 or len(set(targets))!=len(targets):reasons.append('数据挂载数量或目标冲突')
        if len(environment)>32:reasons.append('环境参数超出当前草稿上限')
        provenance['blockers']=list(dict.fromkeys(reasons))
        if provenance['blockers']:
            provenance['status']='blocked';note='fnOS Docker · 待完整适配：'+'；'.join(provenance['blockers'][:4])
        else:
            provenance['status']='candidate';note='fnOS Docker · 单服务字段完整候选，仍需镜像架构、宿主账号与权限核验'
            draft.update(image=provenance['images'][0]['resolvedImage'],containerPort=container_port,dataTargets=targets,environment=environment)
    suffix=f'\n\n[{note}]\n来源：{source_url}；来源许可 GPLv3。'
    draft['description']=str(app.get('description') or app.get('display_name') or slug)[:max(0,2048-len(suffix))]+suffix
    return draft,provenance


def sql_literal(value):return "'"+value.replace("'","''")+"'"


def render_sql(apps,existing_ids=EXISTING_IDS):
    ids=','.join(sql_literal(v) for v in existing_ids)
    rows=[]
    for app in apps:
        raw=json.dumps(app,ensure_ascii=False,separators=(',',':'))
        rows.append('('+sql_literal(app['id'])+', '+sql_literal(raw)+', NULL, 1)')
    values_sql=',\n  '.join(rows)
    return f'''-- Generated fnOS catalog drafts; source {SOURCE_REPOSITORY}@{PINNED_COMMIT}
-- Public GPLv3-derived metadata only; no secrets, publication or existing-row updates.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL standard_conforming_strings = on;
LOCK TABLE cloud_apps IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE fnos_import_guard ON COMMIT DROP AS
SELECT id, md5(jsonb_build_array(id,draft_json,published_json,revision)::text) AS row_hash FROM cloud_apps;
DO $fnos_guard$
BEGIN
  IF (SELECT count(*) FROM cloud_apps WHERE id IN ({ids})) <> {len(existing_ids)} THEN
    RAISE EXCEPTION 'Expected existing catalog IDs missing; import refused';
  END IF;
END
$fnos_guard$;
SELECT 'preserved-before' AS phase,id,row_hash FROM fnos_import_guard WHERE id IN ({ids}) ORDER BY id;
WITH inserted AS (
  INSERT INTO cloud_apps(id,draft_json,published_json,revision) VALUES
  {values_sql}
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT count(*) AS inserted_drafts FROM inserted;
DO $fnos_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fnos_import_guard g LEFT JOIN cloud_apps a USING(id)
    WHERE a.id IS NULL OR g.row_hash <> md5(jsonb_build_array(a.id,a.draft_json,a.published_json,a.revision)::text)
  ) THEN
    RAISE EXCEPTION 'Existing catalog row changed; whole import rolled back';
  END IF;
END
$fnos_guard$;
SELECT 'preserved-after' AS phase,id,md5(jsonb_build_array(id,draft_json,published_json,revision)::text) AS row_hash
FROM cloud_apps WHERE id IN ({ids}) ORDER BY id;
SELECT count(*) AS total_apps, count(*) FILTER (WHERE published_json IS NOT NULL) AS published_apps FROM cloud_apps;
COMMIT;
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=pathlib.Path,required=True)
    parser.add_argument('--source-root',type=pathlib.Path,required=True)
    parser.add_argument('--source-tree',type=pathlib.Path,required=True)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args()
    if args.output.exists():raise ValueError('output already exists; retain previous import evidence')
    source_catalog=args.source_root/'apps.json'
    if args.catalog.read_bytes()!=source_catalog.read_bytes():raise ValueError('catalog differs from pinned source tree')
    tree=json.loads(args.source_tree.read_text())
    if tree.get('sha')!=PINNED_COMMIT or tree.get('truncated'):raise ValueError('source tree is not the complete pinned commit')
    blobs={n['path']:n['sha'] for n in tree['tree'] if n['type']=='blob'}
    required=['apps.json','README.md','LICENSE']
    source=json.loads(args.catalog.read_text());all_apps=source.get('apps')
    if not isinstance(all_apps,list):raise ValueError('source catalog apps missing')
    slugs=[a['slug'] for a in all_apps]
    if len(set(slugs))!=len(slugs):raise ValueError('duplicate source slug')
    for app in all_apps:
        required.append('apps/'+app['slug']+'/fnos/manifest')
        if app.get('app_type')=='docker':required.append('apps/'+app['slug']+'/fnos/docker/docker-compose.yaml')
    for name in required:
        data=(args.source_root/name).read_bytes()
        digest=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        if blobs.get(name)!=digest:raise ValueError('pinned source blob mismatch: '+name)
    drafts=[];provenance=[]
    for app in all_apps:
        draft,metadata=convert_app(app,args.source_root)
        metadata['preserveExisting']=draft['id'] in EXISTING_IDS
        drafts.append(draft);provenance.append(metadata)
    args.output.mkdir(parents=True)
    counts={'total':len(drafts),'docker':sum(x.get('app_type')=='docker' for x in all_apps),
            'native':sum(x.get('app_type')!='docker' for x in all_apps),
            'completeCandidates':sum(p['status']=='candidate' for p in provenance),
            'blockedDocker':sum(p['status']=='blocked' for p in provenance),
            'preservedExistingMatches':sum(p['preserveExisting'] for p in provenance),
            'expectedNewDrafts':sum(not p['preserveExisting'] for p in provenance)}
    report={'sourceRepository':SOURCE_REPOSITORY,'sourceCommit':PINNED_COMMIT,'license':'GPL-3.0',
            'counts':counts,'sourceCatalogSHA256':hashlib.sha256(args.catalog.read_bytes()).hexdigest(),
            'blockerCounts':dict(collections.Counter(b for p in provenance for b in p['blockers'])),
            'publication':'All incoming records are drafts; no published rows are overwritten.'}
    (args.output/'drafts.json').write_text(json.dumps(drafts,ensure_ascii=False,indent=2)+'\n')
    (args.output/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n')
    (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    (args.output/'import.sql').write_text(render_sql(drafts))
    shutil.copyfile(args.source_root/'LICENSE',args.output/'UPSTREAM-LICENSE.txt')
    (args.output/'README.md').write_text(f'''# fnOS catalog draft import

Source: [{SOURCE_REPOSITORY}]({SOURCE_REPOSITORY}), pinned commit `{PINNED_COMMIT}`.
Upstream README: {SOURCE_REPOSITORY}/blob/{PINNED_COMMIT}/README.md
Upstream license: GPLv3, retained verbatim in `UPSTREAM-LICENSE.txt`.
Catalog descriptions and sanitized Compose structure are derived from that source.
Each application's own image/software license and native FPK permission remain separate.

This package contains {counts['total']} drafts: {counts['docker']} Docker and {counts['native']} native FPK.
{counts['completeCandidates']} single-service field candidates still require image/architecture/permission review.
{counts['blockedDocker']} Docker definitions cannot be represented faithfully in the existing single-service model.
Native FPK and blocked Docker records intentionally have no fabricated installable image or port.
Full sanitized definitions, source URLs and blockers are in `provenance.json`.

Back up the destination before running `psql --file=import.sql` as an authorized database administrator.
SQL locks only `cloud_apps`, snapshots hashes of all existing rows, inserts with `ON CONFLICT DO NOTHING`,
keeps `published_json=NULL`, and verifies all previous columns unchanged before COMMIT.
Existing seven IDs are required and printed as before/after hashes; no account or publication records are modified.
Expected first run on the current seven-row database: {counts['expectedNewDrafts']} inserts and {7+counts['expectedNewDrafts']} total rows.
Repeated execution inserts zero rows. The public client catalog does not show unpublished drafts.
''')
    files=sorted(p for p in args.output.iterdir() if p.is_file())
    (args.output/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files))
    print(json.dumps({'output':str(args.output),'sourceCommit':PINNED_COMMIT,'counts':counts},ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,yaml.YAMLError) as error:sys.exit('fnOS import generation stopped: '+str(error))
