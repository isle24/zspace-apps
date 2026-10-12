import os,subprocess,tempfile,unittest,pathlib
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
if __name__=='__main__':unittest.main()
