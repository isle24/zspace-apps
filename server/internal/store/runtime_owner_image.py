"""The single reviewed author delivery. No arbitrary image or archive inputs."""
import copy, gzip, hashlib, io, json, re, tarfile

OWNER_CONFIG = 'sha256:0f1ea3da17ac3c2a37a7525323dbaeb5ea1c3c0ae7a5508329ca8f6a008f9ccb'
OWNER_TAG = 'nasreader:free-platforms-reader-licensed-amd64-20261010'
OWNER_SHA256 = '90e7de4c1d97c548a838d086190b80ab52f7feb4be3abef013f3fcf4562fd491'
OWNER_SIZE = 44854784
OWNER_DIFF_IDS = ['sha256:' + x for x in [
 'e63b02c2b5c761df2cb95e657d744f27d95da4e051235a13c80b88cd68eab188',
 '15a1fd6977575dfbd3ce1a551140eeb3210e944b7d50bf69e69f5815b8506c7a',
 'f8b32a7528ea40fb89aa834497fa3562c9099801ee2abbdc7e87714f48839408',
 '54f59a3b6c5d3204c4d96327b21b1484fcb57919cbe1b72d6aa99adb311592b4',
 'e36189ddb1f2188fd22b562f2a5551aec748aade5ba6a1c9204991e3c90ff2a7',
 '287a4a9a15206855817ba3624df195400b576c9a78326bc156625555c2cfe25a']]
OWNER_LAYERS = [
 'd0c1d894c237d8192cbcd37e435031ad4eddec173299568a5a05869c2e40dfa3',
 '2f8985544458460723e199cbd39c018326c475bc05c356f7dd784e058de6043c',
 '48cf003a7e84db778a47e9146cd8005cfeb36e6b5366afff83802e3c84cde89d',
 '46c21657b19274a585bb7db1df613eafd75b6fc8468622e97de6b066548a19f8',
 'ea18e113292c0670411ae86444f9f363facad9d177cfe32b31b8de0acf9a88cf',
 '11f2f985d1d35c1daa4d167017917d132af5d3a58ec866c9b44d49c47d5254bf']
# Docker-save also carries the reviewed BuildKit index/provenance, not another
# installable software image. Every blob is hashed; none is executed/extracted.
OWNER_METADATA = [
 '0dba6fc9b0ca6ce0bf4035533041f06d48339379f23c6bc6f9d4fe038dcc150f',
 '782b4a7523b4df8f8e04f1050979c106d7f70c783e1283a81b7f6aaf83d78209',
 'aba92a43ed26c0d148fc683c2f27f87640d93cbe9bbd3b51832f367ecd861579',
 'aef71e080923d7a1123a86faf749cfa0643f3ab7a93f35136f0b7a6eabcdff79',
 'f08a1e18c364f0898ff4233caf310400de49b9ab19357105b2c45c71314bbf16']

def owner_reject():
    raise ValueError('owner_image_verification_failed')

def owner_descriptor():
    return dict(serviceId='nasreader', tagReference=OWNER_TAG, reference=OWNER_CONFIG,
                digest='', platform='linux/amd64', publisher='nasreader', deliverySource='owner-archive',
                configId=OWNER_CONFIG, archiveSha256=OWNER_SHA256, archiveSizeBytes=OWNER_SIZE,
                diffIds=OWNER_DIFF_IDS.copy())

def check_owner_image(im):
    if not isinstance(im,dict) or im.get('Id') != OWNER_CONFIG or im.get('Os') != 'linux' or im.get('Architecture') != 'amd64' or im.get('RootFS') != {'Type':'layers','Layers':OWNER_DIFF_IDS}:
        owner_reject()
    return im

def verify_archive_envelope(data):
    if len(data) != OWNER_SIZE or hashlib.sha256(data).hexdigest() != OWNER_SHA256:
        owner_reject()

def validate_owner_archive(data):
    verify_archive_envelope(data)
    blobs = {x for x in OWNER_LAYERS + OWNER_METADATA + [OWNER_CONFIG[7:]]}
    allowed = {'blobs','blobs/sha256','manifest.json','index.json','oci-layout'} | {'blobs/sha256/'+x for x in blobs}
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as archive:
        for member in archive:
            if member.name not in allowed or member.name in entries or member.pax_headers or member.linkname or member.size < 0 or member.size > OWNER_SIZE:
                owner_reject()
            directory = member.name in ('blobs','blobs/sha256')
            if directory and (not member.isdir() or member.size != 0) or not directory and not member.isfile():
                owner_reject()
            entries[member.name] = b'' if directory else archive.extractfile(member).read(OWNER_SIZE+1)
        if set(entries) != allowed:
            owner_reject()
    for digest in blobs:
        if hashlib.sha256(entries['blobs/sha256/'+digest]).hexdigest() != digest:
            owner_reject()
    manifest = json.loads(entries['manifest.json'])
    expected = [{'Config':'blobs/sha256/'+OWNER_CONFIG[7:],'RepoTags':[OWNER_TAG],'Layers':['blobs/sha256/'+x for x in OWNER_LAYERS]}]
    if manifest != expected or json.loads(entries['oci-layout']) != {'imageLayoutVersion':'1.0.0'}:
        owner_reject()
    config = json.loads(entries[expected[0]['Config']])
    if config.get('os') != 'linux' or config.get('architecture') != 'amd64' or config.get('rootfs') != {'type':'layers','diff_ids':OWNER_DIFF_IDS}:
        owner_reject()
    index = json.loads(entries['index.json'])
    if index.get('schemaVersion') != 2 or len(index.get('manifests',[])) != 1:
        owner_reject()
    descriptor = index['manifests'][0]
    if descriptor.get('digest') != 'sha256:'+OWNER_METADATA[-1] or descriptor.get('size') != len(entries['blobs/sha256/'+OWNER_METADATA[-1]]):
        owner_reject()
    # Bound decompression independently of the compressed size; hash in memory
    # without ever unpacking a layer into the host filesystem.
    total = 0
    for digest, diff_id in zip(OWNER_LAYERS, OWNER_DIFF_IDS):
        calculated = hashlib.sha256()
        with gzip.GzipFile(fileobj=io.BytesIO(entries['blobs/sha256/'+digest])) as layer:
            while True:
                chunk = layer.read(1024*1024)
                if not chunk:break
                total += len(chunk)
                if total > 512*1024*1024:owner_reject()
                calculated.update(chunk)
        if 'sha256:'+calculated.hexdigest() != diff_id:owner_reject()
    return owner_descriptor()

def owner_load_manifest():
    return [{'Config':'blobs/sha256/'+OWNER_CONFIG[7:],
             'Layers':['blobs/sha256/'+x for x in OWNER_LAYERS]}]

def validate_owner_load_archive(data):
    # This is a separate envelope from the immutable author delivery. Accept
    # exactly seven software files and an untagged Docker-save manifest, with
    # no index, provenance, repositories, directories, links or extra headers.
    if not data or len(data) > OWNER_SIZE:owner_reject()
    expected = owner_load_manifest()
    allowed = {expected[0]['Config'], 'manifest.json', *expected[0]['Layers']}
    entries = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as archive:
        for member in archive:
            if member.name not in allowed or member.name in entries or member.type != tarfile.REGTYPE or member.offset_data != member.offset+512 or member.pax_headers or member.linkname or member.size < 0 or member.size > OWNER_SIZE:
                owner_reject()
            total += member.size
            if total > OWNER_SIZE:owner_reject()
            entries[member.name] = archive.extractfile(member).read(member.size+1)
            if len(entries[member.name]) != member.size:owner_reject()
        if set(entries) != allowed:owner_reject()
        # Reject trailing hidden archives/metadata as well as ordinary members.
        if any(data[archive.offset:]):owner_reject()
    if json.loads(entries['manifest.json']) != expected:owner_reject()
    for digest in [OWNER_CONFIG[7:]] + OWNER_LAYERS:
        if hashlib.sha256(entries['blobs/sha256/'+digest]).hexdigest() != digest:owner_reject()
    config = json.loads(entries[expected[0]['Config']])
    if config.get('os') != 'linux' or config.get('architecture') != 'amd64' or config.get('rootfs') != {'type':'layers','diff_ids':OWNER_DIFF_IDS}:owner_reject()
    total = 0
    for digest, diff_id in zip(OWNER_LAYERS, OWNER_DIFF_IDS):
        calculated = hashlib.sha256()
        with gzip.GzipFile(fileobj=io.BytesIO(entries['blobs/sha256/'+digest])) as layer:
            while True:
                chunk = layer.read(1024*1024)
                if not chunk:break
                total += len(chunk)
                if total > 512*1024*1024:owner_reject()
                calculated.update(chunk)
        if 'sha256:'+calculated.hexdigest() != diff_id:owner_reject()
    # archiveSha256/Size describe ORIGINAL author bytes, never this load TAR.
    return owner_descriptor()

def derive_owner_load_archive(data):
    validate_owner_archive(data)
    manifest = owner_load_manifest()
    out = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as source, tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as target:
        for name in [manifest[0]['Config']] + manifest[0]['Layers']:
            original = source.getmember(name)
            entry = tarfile.TarInfo(name)
            entry.size = original.size
            with source.extractfile(original) as body:
                target.addfile(entry,body)
        body = json.dumps(manifest,separators=(',',':')).encode('utf-8')
        entry = tarfile.TarInfo('manifest.json');entry.size = len(body)
        target.addfile(entry,io.BytesIO(body))
    derived = out.getvalue()
    validate_owner_load_archive(derived)
    return derived

def import_owner_archive(data, docker):
    identity = validate_owner_archive(data)
    def ids(reference=None):
        args = ['image','ls','--all','--no-trunc','--quiet']
        if reference is not None:args += ['--filter','reference='+reference]
        found = docker(args).splitlines()
        if any(not re.fullmatch(r'sha256:[a-f0-9]{64}',x) for x in found):owner_reject()
        return set(found)
    def inspect(reference):
        result = json.loads(docker(['image','inspect',reference]))
        if not isinstance(result,list) or len(result)!=1:owner_reject()
        return check_owner_image(result[0])
    def guard_tag():
        tagged = ids(OWNER_TAG)
        if tagged:
            if tagged != {OWNER_CONFIG}:owner_reject()
            inspect(OWNER_TAG)
    guard_tag()
    if OWNER_CONFIG in ids():
        inspect(OWNER_CONFIG)
        guard_tag()
        return dict(identity,loaded=False)
    derived = derive_owner_load_archive(data)
    guard_tag()
    # RepoTags and OCI names cannot be published by this minimal load TAR. A
    # concurrent writer's binding and any partial image survive every failure.
    docker(['image','load'],stdin=derived)
    inspect(OWNER_CONFIG)
    guard_tag()
    return dict(identity,loaded=True)
