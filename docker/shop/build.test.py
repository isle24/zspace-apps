import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('shop_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def test_version_and_latest_are_tags_of_the_same_build(self):
        args = build.build_arguments('isle204/zspace-shop:2026.10.14-r2', True, '/public/context')
        self.assertEqual([args[index + 1] for index, value in enumerate(args) if value == '--tag'], ['isle204/zspace-shop:2026.10.14-r2', 'isle204/zspace-shop:latest'])
        self.assertIn('--push', args)
        self.assertEqual(args[-1], '/public/context')
        self.assertEqual(args.count('build'), 1)

    def test_local_load_also_updates_latest_without_a_second_build(self):
        args = build.build_arguments('registry.example:5000/nas/shop:2026.10.14-r2', False, '/public/context')
        self.assertIn('registry.example:5000/nas/shop:latest', args)
        self.assertIn('--load', args)
        self.assertNotIn('--push', args)

    def test_a_version_tag_is_required(self):
        for value in ('isle204/zspace-shop:latest', 'isle204/zspace-shop', 'registry.example:5000/nas/shop', 'repo:bad tag', 'repo@sha256:' + 'a' * 64):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build.build_arguments(value, True, '/public/context')


if __name__ == '__main__': unittest.main()
