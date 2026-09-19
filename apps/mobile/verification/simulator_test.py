"""Unit tests for the Simulator lease; they never touch a real device."""
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name('simulator.py')
IPHONE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
IPAD = 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2'
RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
OLD_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-25-0'


def load_simulator_module():
    """Load the module directly: the tests must run without pnpm or a package."""
    spec = importlib.util.spec_from_file_location('memoh_verify_simulator', MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def device(udid, name, state='Shutdown', device_type=IPHONE, available=True):
    return {
        'udid': udid,
        'name': name,
        'state': state,
        'isAvailable': available,
        'deviceTypeIdentifier': device_type,
    }


def inventory(*devices, runtime=RUNTIME):
    return {'devices': {runtime: list(devices)}}


class FakeSimctl:
    """A `simctl` that keeps its devices in memory and records every call."""

    def __init__(self, devices, runtime=RUNTIME, fail_on=None, hangs=()):
        self.inventory = {'devices': {runtime: copy.deepcopy(list(devices))}}
        self.calls = []
        self.fail_on = fail_on
        # 卡在中间态的设备：任何指向它的命令都**不返回**（真实机器上由 run_simctl 的
        # 120s 超时收场）。测试里直接抛 TimeoutExpired——它比"等 120 秒"更快也更诚实。
        self.hangs = set(hangs)

    def __call__(self, *command, check=True, timeout=120):
        self.calls.append((command, timeout))
        if len(command) > 1 and command[1] in self.hangs:
            raise subprocess.TimeoutExpired(command, timeout)
        if command[0] == self.fail_on:
            raise subprocess.CalledProcessError(1, command)
        if command == ('list', 'devices', '--json'):
            return subprocess.CompletedProcess(command, 0, json.dumps(self.inventory), '')
        if command[0] == 'create':
            created = device('CREATED', command[1], device_type=command[2])
            self.inventory['devices'].setdefault(command[3], []).append(created)
            return subprocess.CompletedProcess(command, 0, 'CREATED\n', '')
        target = self.device(command[1])
        if command[0] == 'shutdown':
            if target['state'] == 'Shutdown':
                return subprocess.CompletedProcess(command, 149, '', 'Unable to shutdown device in state Shutdown')
            target['state'] = 'Shutdown'
        elif command[0] == 'rename':
            target['name'] = command[2]
        elif command[0] == 'boot':
            target['state'] = 'Booted'
        elif command[0] == 'bootstatus':
            if target['state'] == 'Shutdown':
                return subprocess.CompletedProcess(command, 1, '', 'device is shutdown')
        elif command[0] == 'delete':
            for devices in self.inventory['devices'].values():
                devices[:] = [entry for entry in devices if entry['udid'] != command[1]]
        return subprocess.CompletedProcess(command, 0, '', '')

    def device(self, udid):
        for devices in self.inventory['devices'].values():
            for entry in devices:
                if entry['udid'] == udid:
                    return entry
        raise AssertionError(f'no such device {udid}')

    def state_of(self, udid):
        return self.device(udid)['state']

    def name_of(self, udid):
        return self.device(udid)['name']

    def commands(self):
        return [command[0] for command, _ in self.calls]

    def boot_timeouts(self):
        return [timeout for command, timeout in self.calls if command[0] == 'bootstatus']

    def calls_about(self, udid):
        """指向这台设备的命令（用来证明"我们一条都没发"）。"""
        return [command for command, _ in self.calls if len(command) > 1 and command[1] == udid]


@contextlib.contextmanager
def pooled(devices, **kwargs):
    simulator = load_simulator_module()
    with tempfile.TemporaryDirectory() as locks:
        simctl = FakeSimctl(devices)
        pool = simulator.SimulatorPool(simctl=simctl, lock_directory=locks, **kwargs)
        yield simulator, simctl, pool, Path(locks)


def run_main(simulator, argv, pool):
    """Call the CLI with the pool injected; the real pool would boot a device."""
    original = simulator.SimulatorPool
    simulator.SimulatorPool = lambda **kwargs: pool
    try:
        return simulator.main(argv)
    finally:
        simulator.SimulatorPool = original


class ManagedNameTests(unittest.TestCase):
    def test_spellings_of_one_verification_share_one_device(self):
        simulator = load_simulator_module()

        self.assertEqual(simulator.managed_name('app-launch'), 'Memoh app launch Verify')
        self.assertEqual(simulator.managed_name('App Launch'), 'Memoh app launch Verify')
        self.assertEqual(simulator.managed_name('  UI  app-launch '), 'Memoh ui app launch Verify')
        self.assertEqual(simulator.slugify('App Launch'), simulator.slugify('app-launch'))

    def test_a_device_name_is_accepted_where_a_verification_name_is_expected(self):
        simulator = load_simulator_module()

        self.assertEqual(simulator.resolve_managed_name('Memoh app launch Verify'), 'Memoh app launch Verify')
        self.assertEqual(simulator.resolve_managed_name('app-launch'), 'Memoh app launch Verify')

    def test_unusable_names_are_rejected(self):
        simulator = load_simulator_module()

        for name in ['', '   ', 'a\nb', '---', 'x' * (simulator.MAX_NAME_LENGTH + 2)]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    simulator.managed_name(name)


class ReusableDeviceTests(unittest.TestCase):
    def test_only_managed_devices_on_the_pinned_runtime_are_candidates(self):
        simulator = load_simulator_module()
        devices = inventory(
            device('MINE', 'Memoh app launch Verify'),
            device('PERSONAL', 'Truth Truth E2E iPhone'),
            device('OTHER-PROJECT', 'Lody Chat Verify'),
            device('IPAD', 'Memoh tablet Verify', device_type=IPAD),
            device('UNAVAILABLE', 'Memoh gone Verify', available=False),
        )
        devices['devices'][OLD_RUNTIME] = [device('OLD', 'Memoh old runtime Verify')]

        candidates = simulator.reusable_devices(devices, IPHONE)

        self.assertEqual([candidate['udid'] for candidate in candidates], ['MINE'])

    def test_the_device_type_selects_the_pool(self):
        simulator = load_simulator_module()
        devices = inventory(
            device('PHONE', 'Memoh app launch Verify'),
            device('TABLET', 'Memoh tablet Verify', device_type=IPAD),
        )

        self.assertEqual([c['udid'] for c in simulator.reusable_devices(devices, IPAD)], ['TABLET'])


class LeaseTests(unittest.TestCase):
    def test_a_shutdown_device_is_reused_renamed_and_left_warm(self):
        with pooled([device('A', 'Memoh old name Verify')]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch') as (udid, _token):
                self.assertEqual(udid, 'A')
                self.assertEqual(simctl.name_of('A'), 'Memoh app launch Verify')
                self.assertEqual(simctl.state_of('A'), 'Booted')
                self.assertEqual(simctl.boot_timeouts(), [simulator.BOOT_TIMEOUT])
            self.assertEqual(simctl.state_of('A'), 'Booted', 'the default lease keeps the device ready')
            self.assertTrue((locks / 'A.managed').exists())
            self.assertNotIn('erase', simctl.commands())
            self.assertFalse(pool.is_locked('A.lock'), 'the device lock is released')

    def test_shutdown_after_releases_both_the_device_and_its_marker(self):
        with pooled([device('A', 'Memoh old name Verify')]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch', shutdown_after=True) as (udid, _token):
                self.assertEqual(simctl.state_of(udid), 'Booted')
            self.assertEqual(simctl.state_of('A'), 'Shutdown')
            self.assertFalse((locks / 'A.managed').exists())

    def test_an_empty_pool_creates_a_device_and_hands_over_its_udid(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch') as (udid, _token):
                self.assertEqual(udid, 'CREATED')
                self.assertEqual(simctl.name_of('CREATED'), 'Memoh app launch Verify')
                self.assertTrue((locks / 'CREATED.managed').exists())

    def test_the_lease_exports_the_udid_to_the_command(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            with contextlib.redirect_stderr(io.StringIO()):
                code = simulator.run_with_simulator(
                    pool,
                    'app-launch',
                    [sys.executable, '-c', 'import os; assert os.environ["MEMOH_VERIFY_UDID"] == "CREATED"'],
                    environment={'MEMOH_VERIFY_UDID': 'SHOULD-BE-REPLACED'},
                )
            self.assertEqual(code, 0)
            self.assertEqual(simctl.name_of('CREATED'), 'Memoh app launch Verify')

    def test_a_booted_device_without_our_marker_is_left_alone(self):
        with pooled([device('SOMEONE-ELSES', 'Memoh other run Verify', state='Booted')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            with pool.lease('app-launch') as (udid, _token):
                self.assertEqual(udid, 'CREATED')
            self.assertEqual(simctl.state_of('SOMEONE-ELSES'), 'Booted')
            self.assertEqual(simctl.name_of('SOMEONE-ELSES'), 'Memoh other run Verify')

    def test_a_warm_marked_device_is_reused(self):
        with pooled([device('WARM', 'Memoh other run Verify', state='Booted')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            (locks / 'WARM.managed').touch()
            with pool.lease('app-launch') as (udid, _token):
                self.assertEqual(udid, 'WARM')
            self.assertEqual(simctl.name_of('WARM'), 'Memoh app launch Verify')

    def test_a_locked_device_is_skipped_so_two_runs_never_share_one(self):
        with pooled([device('A', 'Memoh one Verify'), device('B', 'Memoh two Verify')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            held = pool.acquire_lock('A.lock', blocking=True)
            try:
                with pool.lease('app-launch') as (udid, _token):
                    self.assertEqual(udid, 'B')
            finally:
                held.close()

    def test_the_pool_lock_is_released_as_soon_as_a_device_is_chosen(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch'):
                contender = pool.acquire_lock('.pool.lock', blocking=False)
                self.assertIsNotNone(contender, 'parallel leases must not wait on the selection lock')
                contender.close()

    def test_a_failing_run_still_frees_the_device_lock(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            with self.assertRaises(RuntimeError):
                with pool.lease('app-launch'):
                    raise RuntimeError('the command failed')
            self.assertFalse(pool.is_locked('A.lock'))

    def test_a_device_that_fails_to_boot_is_reported_and_unlocked(self):
        with pooled([device('A', 'Memoh app launch Verify')], ) as (simulator, simctl, pool, locks):
            simctl.fail_on = 'boot'
            with self.assertRaises(subprocess.CalledProcessError):
                with pool.lease('app-launch'):
                    self.fail('the lease must not yield a device that failed to boot')
            self.assertFalse(pool.is_locked('A.lock'))

    def test_a_missing_runtime_says_so_instead_of_failing_in_simctl(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            simctl.inventory['devices'] = {OLD_RUNTIME: simctl.inventory['devices'][RUNTIME]}

            with self.assertRaises(RuntimeError) as caught:
                with pool.lease('app-launch'):
                    self.fail('no device can be leased without the pinned runtime')

            self.assertIn('is not installed', str(caught.exception))
            self.assertIn(OLD_RUNTIME.split('.')[-1], str(caught.exception))


class SequencedNameTests(unittest.TestCase):
    """**序号名字也是池子里的一员**（2026-09-17 修）。

    `available_name` 撞名时会造 `… Verify 2`，而池子的判据曾经是 `^Memoh .+ Verify$`——
    于是**它自己造出来的设备，它自己认不出**。那些设备不进候选、`--list` 里也看不见，
    下一次租约另造一台。实测这台机器上攒了 7 台这样的设备，池子里一度只剩 1 台。
    """

    def test_the_bare_name_is_still_the_only_unindexed_form(self):
        simulator = load_simulator_module()

        self.assertTrue(simulator.MANAGED_NAME.fullmatch('Memoh anything Verify'))
        self.assertIsNone(simulator.MANAGED_NAME.fullmatch('Memoh Verify'))

    def test_an_index_is_part_of_a_managed_name(self):
        simulator = load_simulator_module()

        for name in ['Memoh app launch Verify 2', 'Memoh a11y xxxl Verify 12']:
            with self.subTest(name=name):
                self.assertTrue(simulator.MANAGED_NAME.fullmatch(name))
                # `--release 'Memoh app launch Verify 2'` 这种写法要能直接当设备名用。
                self.assertEqual(simulator.resolve_managed_name(name), name)
        for impostor in ['Memoh app launch Verify 2x', 'Memoh Verify 2', 'Memoh KitHosted']:
            with self.subTest(impostor=impostor):
                self.assertIsNone(simulator.MANAGED_NAME.fullmatch(impostor))

    def test_a_sequenced_device_is_a_candidate(self):
        simulator = load_simulator_module()
        devices = inventory(
            device('PLAIN', 'Memoh app launch Verify'),
            device('SEQUENCED', 'Memoh app launch Verify 2'),
        )

        self.assertEqual(
            [candidate['udid'] for candidate in simulator.reusable_devices(devices, IPHONE)],
            ['PLAIN', 'SEQUENCED'],
        )

    def test_a_lease_reuses_a_sequenced_device_instead_of_creating_another(self):
        with pooled([device('SEQUENCED', 'Memoh app launch Verify 2')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            with pool.lease('app-launch') as (udid, _token):
                self.assertEqual(udid, 'SEQUENCED')

            self.assertNotIn('create', simctl.commands(), '序号设备要被复用，不是再造一台')
            self.assertEqual(simctl.name_of('SEQUENCED'), 'Memoh app launch Verify')


class StuckDeviceTests(unittest.TestCase):
    """**卡在中间态的设备不许拖住租约**（2026-09-17 修）。

    真实的坏状态（24E817BA）：state=`Shutting Down`、没有进程在推进它。这时 `simctl`
    对 `shutdown` / `boot` / `bootstatus -b` 一律**不返回**（实测 15s 都没回），于是租约
    白等 `run_simctl` 的 120 秒再失败，每个人都要等一次。处置：不进候选、一条命令都不发、
    把状态印出来。
    """

    def test_a_stuck_device_is_skipped_and_reported(self):
        with pooled(
            [
                device('STUCK', 'Memoh app launch Verify', state='Shutting Down'),
                device('HEALTHY', 'Memoh app launch Verify 2'),
            ]
        ) as (simulator, simctl, pool, locks):
            simctl.hangs = {'STUCK'}
            with contextlib.redirect_stderr(io.StringIO()) as lease_log:
                with pool.lease('app-launch') as (udid, _token):
                    self.assertEqual(udid, 'HEALTHY', '卡住的设备不能被选')

            self.assertEqual(simctl.calls_about('STUCK'), [], '一个字都不该发给它')
            self.assertIn('STUCK', lease_log.getvalue(), '跳过这件事必须说出来')
            self.assertIn('Shutting Down', lease_log.getvalue())

    def test_a_pool_of_stuck_devices_creates_one_instead_of_waiting(self):
        with pooled([device('STUCK', 'Memoh app launch Verify', state='Shutting Down')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            simctl.hangs = {'STUCK'}
            with contextlib.redirect_stderr(io.StringIO()):
                with pool.lease('app-launch') as (udid, _token):
                    self.assertEqual(udid, 'CREATED')

            self.assertEqual(simctl.calls_about('STUCK'), [])
            self.assertEqual(simctl.state_of('STUCK'), 'Shutting Down', '我们不动它')

    def test_a_transitional_device_under_someone_elses_lease_is_left_quietly(self):
        """**有人持锁就不是"卡死"**：那只是别的租约正在关机/启动（正常的一两秒）。

        说过一次错话：把别人正在用的设备报成"没有进程在推进它"。判据要两条一起看
        ——中间态 **且**没人持锁。
        """
        with pooled(
            [
                device('SHUTTING-DOWN', 'Memoh app launch Verify', state='Shutting Down'),
                device('HEALTHY', 'Memoh app launch Verify 2'),
            ]
        ) as (simulator, simctl, pool, locks):
            held = pool.acquire_lock('SHUTTING-DOWN.lock', blocking=True)
            try:
                with contextlib.redirect_stderr(io.StringIO()) as lease_log:
                    with pool.lease('app-launch') as (udid, _token):
                        self.assertEqual(udid, 'HEALTHY')
            finally:
                held.close()

            self.assertEqual(simctl.calls_about('SHUTTING-DOWN'), [], '别人的设备一个字都不许发')
            self.assertNotIn('SHUTTING-DOWN', lease_log.getvalue(), '不许把别人正在用的设备说成卡死')

    def test_list_does_not_flag_another_lease_s_transitional_device(self):
        with pooled([device('SHUTTING-DOWN', 'Memoh app launch Verify', state='Shutting Down')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            held = pool.acquire_lock('SHUTTING-DOWN.lock', blocking=True)
            try:
                (report,) = pool.report()
            finally:
                held.close()

            self.assertFalse(report['transitional'])

    def test_release_reports_a_stuck_device_instead_of_waiting_on_it(self):
        with pooled([device('STUCK', 'Memoh app launch Verify', state='Shutting Down')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            simctl.hangs = {'STUCK'}
            (locks / 'STUCK.managed').touch()
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = pool.release('app-launch')

            self.assertEqual(code, 0)
            self.assertEqual(simctl.calls_about('STUCK'), [], '不发给它就不会白等')
            self.assertFalse((locks / 'STUCK.managed').exists(), '标记要解除')
            self.assertIn('Shutting Down', buffer.getvalue())
            self.assertIn('simctl shutdown', buffer.getvalue(), '要告诉人怎么清掉它')

    def test_shutdown_after_does_not_wait_on_a_stuck_device(self):
        with pooled([device('STUCK', 'Memoh app launch Verify 2')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            with contextlib.redirect_stderr(io.StringIO()):
                with pool.lease('app-launch', shutdown_after=True) as (udid, _token):
                    self.assertEqual(udid, 'STUCK')

            # 租约里它被启动过；收尾时它已经卡住了（状态停在中间态、进程没了），
            # 此时不许再发命令——发出去就是"不返回"，也就是白等 120s。
            simctl.hangs = {'STUCK'}
            simctl.device('STUCK')['state'] = 'Shutting Down'
            simctl.calls.clear()
            pool.shutdown('STUCK')

            self.assertEqual(simctl.calls_about('STUCK'), [])

    def test_list_flags_a_stuck_device_so_someone_can_clean_it(self):
        with pooled([device('STUCK', 'Memoh app launch Verify', state='Shutting Down')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            (report,) = pool.report()
            self.assertTrue(report['transitional'])

            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                run_main(simulator, ['--list'], pool)

            self.assertIn('卡在中间态', buffer.getvalue())


class HousekeepingTests(unittest.TestCase):
    def test_release_shuts_down_a_forgotten_device(self):
        with pooled([device('A', 'Memoh app launch Verify', state='Booted')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            (locks / 'A.managed').touch()
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = pool.release('app-launch')

            self.assertEqual(code, 0)
            self.assertEqual(simctl.state_of('A'), 'Shutdown')
            self.assertFalse((locks / 'A.managed').exists())
            self.assertIn('released', buffer.getvalue())

    def test_release_refuses_a_device_that_is_in_use(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            held = pool.acquire_lock('A.lock', blocking=True)
            try:
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer):
                    code = pool.release('app-launch')
            finally:
                held.close()

            self.assertEqual(code, 1)
            self.assertIn('in use', buffer.getvalue())
            self.assertFalse(any(command[0] == 'shutdown' for command in simctl.commands()))

    def test_release_reports_an_unknown_device_without_failing(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(pool.release('app-launch'), 0)
            self.assertIn('no managed Simulator', buffer.getvalue())

    def test_purge_deletes_only_unlocked_managed_devices(self):
        with pooled([device('A', 'Memoh one Verify'), device('B', 'Memoh two Verify')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            held = pool.acquire_lock('A.lock', blocking=True)
            try:
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer):
                    self.assertEqual(pool.purge(), 0)
            finally:
                held.close()

            self.assertEqual(simctl.commands().count('delete'), 1)
            self.assertIn('skipping', buffer.getvalue())

    def test_report_shows_state_lock_and_marker(self):
        with pooled([device('A', 'Memoh one Verify', state='Booted')]) as (simulator, simctl, pool, locks):
            (locks / 'A.managed').touch()
            (report,) = pool.report()

            self.assertEqual(report['name'], 'Memoh one Verify')
            self.assertEqual(report['state'], 'Booted')
            self.assertFalse(report['locked'])
            self.assertTrue(report['idleMarker'])

    def test_report_flags_devices_that_share_a_name(self):
        """同名设备必须被标出来：名字不能用来找设备，UDID 才是身份。"""
        with pooled(
            [
                device('A', 'Memoh push acceptance Verify', state='Booted'),
                device('B', 'Memoh push acceptance Verify', state='Booted'),
                device('C', 'Memoh e2e Verify', state='Booted'),
            ]
        ) as (simulator, simctl, pool, locks):
            duplicated = [entry['udid'] for entry in pool.report() if entry['duplicateName']]

            self.assertEqual(duplicated, ['A', 'B'])


class LeaseIdentityTests(unittest.TestCase):
    """**租约是谁的**必须可判定：环境变量里有个 UDID 不等于"我在租约里面"。

    这一组存在的理由就是这台机器上出过三次的事故形态——有人把 UDID 写死（或者从别人那里
    抄了一个），于是 flow 被发到别人的设备上，两边的结论都不成立。判据是 `checked_out_by`
    的三个码：0 我就在里面 / 3 没人持锁 / 4 是别人的。
    """

    def test_a_live_lease_is_recognised_only_by_its_own_token(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch') as (udid, token):
                self.assertEqual(pool.checked_out_by(udid, token)[0], 0)
                for wrong in ['someone-elses-token', '', None]:
                    with self.subTest(token=wrong):
                        self.assertEqual(pool.checked_out_by(udid, wrong)[0], 4)

    def test_a_device_nobody_holds_is_not_mistaken_for_free_to_use(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            self.assertEqual(pool.checked_out_by('A', 'whatever')[0], 3)

    def test_the_holder_description_says_who_since_when(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            with pool.lease('app-launch') as (udid, token):
                description = pool.describe_holder(pool.checked_out_by(udid, token)[1])

            self.assertIn('app-launch', description)
            self.assertIn(str(os.getpid()), description)
            self.assertIn('存活', description)

    def test_check_lease_returns_the_three_codes(self):
        with pooled([device('A', 'Memoh app launch Verify')]) as (simulator, simctl, pool, locks):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                with pool.lease('app-launch') as (udid, token):
                    os.environ['MEMOH_VERIFY_LEASE_TOKEN'] = token
                    try:
                        self.assertEqual(run_main(simulator, ['--check-lease', udid], pool), 0)
                        os.environ['MEMOH_VERIFY_LEASE_TOKEN'] = 'not-mine'
                        self.assertEqual(run_main(simulator, ['--check-lease', udid], pool), 4)
                    finally:
                        os.environ.pop('MEMOH_VERIFY_LEASE_TOKEN', None)

                self.assertEqual(run_main(simulator, ['--check-lease', 'A'], pool), 3)

            self.assertIn('lease ok', buffer.getvalue())
            self.assertIn('没有租约', buffer.getvalue())


class CommandLineTests(unittest.TestCase):
    def test_list_reports_the_pool(self):
        with pooled([device('A', 'Memoh one Verify', state='Booted')]) as (simulator, simctl, pool, locks):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = run_main(simulator, ['--list'], pool)
            printed = buffer.getvalue()

            self.assertEqual(code, 0)
            self.assertIn('Booted', printed)
            self.assertIn('Memoh one Verify', printed)
            self.assertIn('free', printed)

    def test_list_json_is_machine_readable(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                run_main(simulator, ['--list', '--json'], pool)
            self.assertEqual(json.loads(buffer.getvalue()), [])

    def test_a_command_runs_inside_the_lease_and_its_code_is_returned(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            with contextlib.redirect_stderr(io.StringIO()) as lease_log:
                code = run_main(
                    simulator,
                    ['--name', 'app-launch', '--', sys.executable, '-c', 'import sys; sys.exit(3)'],
                    pool,
                )

            self.assertEqual(code, 3)
            self.assertEqual(simctl.name_of('CREATED'), 'Memoh app launch Verify')
            self.assertIn('Memoh app launch Verify', lease_log.getvalue())

    def test_a_name_and_a_command_are_both_required(self):
        with pooled([]) as (simulator, simctl, pool, locks):
            for argv in [[], ['--name', 'app-launch'], ['--', 'echo', 'hi'], ['--name', '   ', '--', 'true']]:
                with self.subTest(argv=argv):
                    buffer = io.StringIO()
                    with contextlib.redirect_stderr(buffer):
                        with self.assertRaises(SystemExit):
                            run_main(simulator, argv, pool)

    def test_release_accepts_either_spelling(self):
        with pooled([device('A', 'Memoh app launch Verify', state='Booted')]) as (
            simulator,
            simctl,
            pool,
            locks,
        ):
            for name in ['app-launch', 'Memoh app launch Verify']:
                with self.subTest(name=name):
                    buffer = io.StringIO()
                    with contextlib.redirect_stdout(buffer):
                        self.assertEqual(run_main(simulator, ['--release', name], pool), 0)


class EnvironmentTests(unittest.TestCase):
    def test_the_environment_variable_name_is_the_contract(self):
        simulator = load_simulator_module()

        self.assertEqual(simulator.ENVIRONMENT_VARIABLE, 'MEMOH_VERIFY_UDID')
        self.assertEqual(simulator.RUNTIME, RUNTIME)
        self.assertTrue(simulator.MANAGED_NAME.fullmatch('Memoh anything Verify'))
        self.assertIsNone(simulator.MANAGED_NAME.fullmatch('Memoh Verify'))

    def test_the_pool_lock_is_a_real_flock(self):
        """Two locks on one path conflict, which is what makes a lease atomic."""
        with tempfile.TemporaryDirectory() as locks:
            held = open(os.path.join(locks, 'A.lock'), 'a+')
            fcntl.flock(held, fcntl.LOCK_EX)
            try:
                contender = open(os.path.join(locks, 'A.lock'), 'a+')
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                contender.close()
            finally:
                held.close()


if __name__ == '__main__':
    unittest.main()
