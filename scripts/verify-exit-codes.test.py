#!/usr/bin/env python3
import os, shutil, subprocess, tempfile, unittest
from pathlib import Path
SOURCE=Path(__file__).with_name('verify.sh')
class VerificationExitCodes(unittest.TestCase):
 def run_case(self,failing):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'scripts').mkdir();shutil.copyfile(SOURCE,root/'scripts/verify.sh')
   bins=root/'apps/client/node_modules/.bin';bins.mkdir(parents=True)
   for tool in ['tsc','vitest','vite']:
    p=bins/tool;p.write_text('#!/bin/sh\n'+('echo "Test Files 1 failed; Tests 1 failed"\n' if tool=='vitest' else 'echo "build completed"\n')+f'exit {7 if tool==failing else 0}\n');p.chmod(0o755)
   # PATH is extended by the script; use its actual installed node to run tiny
   # fixture scripts, each with a deliberate exit status and innocuous output.
   for name in ['bundle-guard','docs-check','static-audit']:
    (root/f'scripts/{name}.mjs').write_text(f'console.log("fixture summary"); process.exit({9 if name==failing else 0});')
   result=subprocess.run(['bash',str(root/'scripts/verify.sh')],cwd=root,text=True,capture_output=True)
   self.assertNotEqual(result.returncode,0,result.stdout)
 def test_failing_tests_are_not_passed_by_a_summary(self):self.run_case('vitest')
 def test_failed_build_is_not_passed_by_zero_error_words(self):self.run_case('vite')
 def test_failed_guard_is_not_passed_by_tail(self):self.run_case('bundle-guard')
if __name__=='__main__':unittest.main()
