import json,os,re,subprocess,tempfile,unittest,pathlib
SCRIPT=pathlib.Path(__file__).with_name('install-docker.sh')
class InstallerContract(unittest.TestCase):
 def call(self,*args):return subprocess.run(['sh',str(SCRIPT),*args],capture_output=True,text=True)
 def test_help_works_without_sshbind_or_development_tools(self):
  r=self.call('--help');self.assertEqual(r.returncode,0);self.assertIn('Docker',r.stdout);self.assertNotIn('sshbind',r.stdout)
 def test_system_directory_is_rejected_before_any_install(self):
  r=self.call('--ip','192.168.3.56','--root','/etc/store');self.assertNotEqual(r.returncode,0);self.assertIn('数据盘',r.stderr)
 def test_invalid_address_cannot_become_a_shell_command(self):
  r=self.call('--ip','192.168.3.56;touch /tmp/unsafe','--root','/data_n008/store');self.assertNotEqual(r.returncode,0);self.assertIn('IP',r.stderr)
 def test_missing_parameters_are_actionable(self):
  r=self.call();self.assertNotEqual(r.returncode,0);self.assertIn('--ip',r.stderr)
 def test_older_supported_engines_reach_the_existing_container_safety_check(self):
  for version in ['20.10.0','20.10.24','24.0.9','26.1.4','27.3.1']:
   with self.subTest(version=version):
    r=self.with_engine(version)
    self.assertNotEqual(r.returncode,0);self.assertIn('已有客户端容器',r.stderr)
 def test_unsupported_and_unknown_engines_fail_before_container_changes(self):
  for version in ['19.03.15','20.9.9','unknown','']:
   with self.subTest(version=version):
    r=self.with_engine(version)
    self.assertNotEqual(r.returncode,0);self.assertNotIn('已有客户端容器',r.stderr)
 def test_client_mount_option_selects_the_supported_nonrecursive_spelling(self):
  for version,expected in [('20.10.0','bind-nonrecursive=true'),('20.10.24','bind-nonrecursive=true'),('24.0.9','bind-nonrecursive=true'),('25.0.0','bind-recursive=disabled'),('26.1.4','bind-recursive=disabled'),('29.0.0','bind-recursive=disabled'),('29.0.0-ce','bind-recursive=disabled')]:
   with self.subTest(version=version):
    r=self.mount_option(version)
    self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),expected)
 def test_client_mount_option_rejects_unknown_and_unsupported_versions(self):
  for version in ['19.03.15','20.9.9','24','24.0','','unknown','v24.0.9','24.0.9\n29.0.0','24.0.9;id']:
   with self.subTest(version=version):
    r=self.mount_option(version)
    self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,'')
 def test_actual_store_create_arguments_apply_the_selected_option_to_all_seven_mounts(self):
  text=SCRIPT.read_text()
  start=text.index('cid="$(docker create ')
  end=text.index('\nprintf',start)
  create=text[start:end]
  for version,expected in [('20.10.24','bind-nonrecursive=true'),('24.0.9','bind-nonrecursive=true'),('26.1.4','bind-recursive=disabled'),('29.0.0','bind-recursive=disabled')]:
   with self.subTest(version=version),tempfile.TemporaryDirectory() as directory:
    directory=pathlib.Path(directory);log=directory/'args.json';docker=directory/'docker'
    docker.write_text('#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ["TEST_ARGS"],"w").write(json.dumps(sys.argv[1:]))\nprint("a"*64)\n');docker.chmod(0o755)
    # Execute the production helper and complete production create command,
    # providing only harmless literal paths; fake Docker records actual argv.
    program=self.mount_library()+'''\nnonrecursive_mount="$(nonrecursive_mount_option "$TEST_CLIENT_VERSION")" || exit 1
store_name=store;uid=10001;gid=10001;socket_gid=10001;ip=192.168.3.56;store_port=18441
deployment=test;RELEASE=test;metadata=/data_test/metadata;data=/data_test/apps
cache=/data_test/docker;store_image=store:test;origin=http://192.168.3.56:18436
'''+create
    r=subprocess.run(['sh','-c',program],capture_output=True,text=True,env={**os.environ,'PATH':str(directory)+os.pathsep+os.environ['PATH'],'TEST_ARGS':str(log),'TEST_CLIENT_VERSION':version})
    self.assertEqual(r.returncode,0,r.stderr)
    args=json.loads(log.read_text());mounts=[args[i+1] for i,a in enumerate(args) if a=='--mount']
    self.assertEqual(len(mounts),7)
    self.assertTrue(all(m.split(',')[-1]==expected for m in mounts),mounts)
 def test_unsupported_and_unknown_clients_fail_before_container_changes(self):
  for version in ['19.03.15','20.9.9','unknown','', '24.0']:
   with self.subTest(version=version):
    r=self.with_engine('24.0.9',client_version=version)
    self.assertNotEqual(r.returncode,0);self.assertNotIn('已有客户端容器',r.stderr);self.assertIn('Docker CLI',r.stderr)
 def mount_library(self):
  match=re.search(r'(?ms)^nonrecursive_mount_option\(\) \{.*?^\}',SCRIPT.read_text())
  self.assertIsNotNone(match,'The client-version mount selector has not been implemented')
  return match.group(0)
 def mount_option(self,version):
  return subprocess.run(['sh','-c',self.mount_library()+'\nnonrecursive_mount_option "$1"','test',version],capture_output=True,text=True)
 def with_engine(self,version,client_version='24.0.9'):
  with tempfile.TemporaryDirectory() as directory:
   docker=pathlib.Path(directory)/'docker'
   docker.write_text('#!/bin/sh\ncase "$*" in\n "version --format {{.Server.Os}}/{{.Server.Arch}}") echo linux/amd64;;\n "version --format {{.Server.Version}}") printf "%s\\n" "$TEST_ENGINE_VERSION";;\n "version --format {{.Client.Version}}") printf "%s\\n" "$TEST_CLIENT_VERSION";;\n "inspect "*) exit 0;;\n *) exit 98;;\nesac\n');docker.chmod(0o755)
   return subprocess.run(['sh',str(SCRIPT),'--ip','192.168.3.56','--root','/data_n008/compat-test','--uid','10001','--gid','10001'],capture_output=True,text=True,env={**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'],'TEST_ENGINE_VERSION':version,'TEST_CLIENT_VERSION':client_version})
if __name__=='__main__':unittest.main()
