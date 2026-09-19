#!/usr/bin/env python3
"""Lease a reusable `Memoh <name> Verify` Simulator for one verification run.

    pnpm verify:simulator --name 'app-launch' -- pnpm verify:native

（``--name`` 后面的命令跑在租约里；``-- <命令>`` 可以接任意串。UI case 那一层
已于 2026-09-19 删除，见 memoh-ios-dev.md §9。）

The lease exports the UDID as ``MEMOH_VERIFY_UDID``; every other verification
script reads that variable instead of choosing a device itself. Device selection
is serialized with a file lock and each device carries its own lock, so several
verifications can run in parallel without fighting over one Simulator. A device
is only ever chosen from the pool this script manages - ``Memoh * Verify`` on the
pinned runtime - so personal devices and other projects are never booted or
erased. By default the device is left booted for the next run (nothing is
erased); ``--shutdown-after`` shuts it down when the command finishes.

``simctl create`` lives in this file only. If any other script needs a device it
must go through the lease.

## 为什么锁文件里要写"谁占着"

`fcntl.flock` 只回答"有没有人占着"，回答不了"谁占着"。而没有第二个答案时，
被挡住的那个人的唯一出路就是**绕开租约**（自己去 `simctl list` 里挑一台）——
这正是这台机器上已经发生过三次的事（三个同名 `*Verify*` 设备、有人把 UDID 写死、
别人的 flow 被发到 E2E 的设备上）。所以持锁的一侧把

    {owner, pid, startedAt, verifyName, token, command}

写进锁文件（**在持锁状态下写**，所以不会互相踩），另一侧就能把"谁占着、从什么时候"
直接印在失败信息里。`token` 是每次租约现生成的随机串，它让"我真的在这个租约里面"
变成可判定的事（见 `--check-lease`），而不是靠"环境变量里有 UDID 就算数"。

## 设备名只是标签，UDID 才是身份

拿设备时优先挑**已经叫这个名字**的那台；要新建设备时，名字已被别的设备用掉就加序号
（`… Verify 2`）。同名设备一旦存在，"按名字找设备"就必然只能找到其中一台——那是
`*Verify*` 现在的状态，也是这套代码刻意不再让任何脚本按名字找设备的原因。

## 序号也是池子里的一员（2026-09-17 修）

上面那条"撞了就加序号"曾经把自己坑死：设备池的判据是 `^Memoh .+ Verify$`，而**自己
发出去的序号名字（`… Verify 2`）不匹配这个正则**。后果不是"名字不好看"，是那些设备
**永久掉出池子**——没人再挑得到它们，而下次租约会再造一台。实测这台机器上因此攒了
`Memoh a11y xxxl Verify 2/3/4/5`、`Memoh frame probe Verify 2/3`，池子里一度只剩 1 台。
所以判据要**容得下自己会生成的名字**：尾部的 ` <序号>` 是可选的。

## 卡在中间态的设备不许进候选（2026-09-17 修）

`simctl` 的中间态（`Shutting Down` / `Booting` / `Creating` / `Deleting`）是设备正在
进入或离开 `Booted`。正常是一两秒的事，但**进程已经死掉**时状态会永远停在那里，而
`simctl` 命令对它的表现是**不返回**：实测（24E817BA，state=`Shutting Down`、无进程）
`shutdown` / `boot` / `bootstatus -b` 三条命令 15 秒都不返回，只能由 `run_simctl` 的超时
把它掐掉——于是**每一次租约白等 120 秒再失败**。

判据要**两条一起看**：中间态 **且没人持着它的租约锁**。有人持锁时它只是正好在关机/启动
（正常的一两秒），那是别人正在用的设备——安静跳过就行，不许说它"卡死了"（说过一次，
那条消息是错的）。两条都成立才是真卡住：没有进程在推进它，而它归池子管。

这种设备对租约没有用处，也不该由租约去修。处置是明确的：**不进候选、不打任何 simctl
命令、把状态印出来**（`--list` 里标 ⚠️，租约时说明跳过了谁）。
真正卡死的设备要人动手（`xcrun simctl shutdown <udid>`，仍不动就重启 CoreSimulatorService）
——写进列表与失败信息里，而不是让每个人自己猜那两分钟花在哪。
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

# Pin both device types and the runtime: a lease must never silently pick up a
# beta runtime or a device type whose geometry no baseline was written against.
DEVICE_TYPES = {
    'iphone': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    'ipad': 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2',
}
RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
MANAGED_PREFIX = 'Memoh '
MANAGED_SUFFIX = ' Verify'
# 尾部的 ` <序号>` 必须收下：`available_name` 自己就会造 `… Verify 2`，而池子的判据认不出
# 自己造出来的名字，就等于每撞一次名字就永久丢掉一台设备（见文件头）。
MANAGED_NAME = re.compile(r'^Memoh .+ Verify(?: \d+)?$')
# simctl 的中间态。落到这里、又没有进程推进的设备，任何 simctl 命令都可能是"不返回"，
# 所以租约一条命令都不发（见文件头）。
TRANSITIONAL_STATES = frozenset({'Booting', 'Shutting Down', 'Creating', 'Deleting'})
ENVIRONMENT_VARIABLE = 'MEMOH_VERIFY_UDID'
TOKEN_VARIABLE = 'MEMOH_VERIFY_LEASE_TOKEN'
LOCK_DIRECTORY = Path.home() / 'Library/Caches/ai.memoh.ios/verify-simulators'
BOOT_TIMEOUT = 300
MAX_NAME_LENGTH = 40


def slugify(verify_name):
    """`App Launch`, `app-launch` and `app_launch` all become `app-launch`.

    Lock files and markers are named after the slug, so two callers spelling the
    same verification differently still share one device.
    """
    return re.sub(r'[^A-Za-z0-9]+', '-', verify_name.strip()).strip('-').lower()


def managed_name(verify_name):
    """Return the managed device name for a verification name, or raise.

    The readable part is the slug, so the name is predictable from the command
    line and `--list` reads back the same device a lease took.
    """
    if not isinstance(verify_name, str):
        raise ValueError('verification name must be a string')
    stripped = verify_name.strip()
    if not stripped or any(ord(character) < 32 for character in stripped):
        raise ValueError('verification name must be non-empty and single-line')
    slug = slugify(stripped)
    if not slug:
        raise ValueError('verification name must contain a letter or a digit')
    if len(slug) > MAX_NAME_LENGTH:
        raise ValueError(f'verification name is longer than {MAX_NAME_LENGTH} characters')
    return f'{MANAGED_PREFIX}{slug.replace("-", " ")}{MANAGED_SUFFIX}'


def resolve_managed_name(value):
    """Accept either a verification name (`app-launch`) or a device name."""
    if MANAGED_NAME.fullmatch(value.strip()):
        return value.strip()
    return managed_name(value)


def run_simctl(*command, check=True, timeout=120):
    return subprocess.run(
        ['xcrun', 'simctl', *command],
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def device_inventory(simctl=run_simctl):
    return json.loads(simctl('list', 'devices', '--json').stdout)


def reusable_devices(inventory, device_type=None, runtime=RUNTIME):
    """Managed devices a lease may consider: this project, right runtime, usable.

    这里**不**排除中间态：卡在 `Shutting Down` 的设备仍要出现在 `--list` 里（人得看得见
    它，才有机会去清），只是不能被租约选中——真正的过滤在 `SimulatorPool.lease`。
    """
    devices = inventory.get('devices', {}).get(runtime, [])
    return [
        device
        for device in devices
        if device.get('isAvailable')
        and MANAGED_NAME.fullmatch(device.get('name', ''))
        and (device_type is None or device.get('deviceTypeIdentifier') == device_type)
    ]


def is_transitional(device):
    """设备正卡在中间态吗（`Shutting Down` / `Booting` / …）。

    判据只用状态名，**不能**看"有没有进程"：`simctl` 不告诉我们哪条进程属于哪台设备，
    而猜错的两种代价都很实在——把别人的设备当成卡死的，或者把卡死的当成活的去等它。
    """
    return device.get('state') in TRANSITIONAL_STATES


def find_device(inventory, name, runtime=RUNTIME):
    for device in inventory.get('devices', {}).get(runtime, []):
        if device.get('name') == name:
            return device
    return None


class SimulatorPool:
    def __init__(
        self,
        simctl=run_simctl,
        lock_directory=None,
        device_type=DEVICE_TYPES['iphone'],
        runtime=RUNTIME,
    ):
        self.simctl = simctl
        self.device_type = device_type
        self.runtime = runtime
        self.lock_directory = Path(lock_directory or LOCK_DIRECTORY)

    # -- locks ---------------------------------------------------------------

    def acquire_lock(self, name, blocking):
        lock_file = (self.lock_directory / name).open('a+')
        flags = fcntl.LOCK_EX
        if not blocking:
            flags |= fcntl.LOCK_NB
        try:
            fcntl.flock(lock_file, flags)
        except BlockingIOError:
            lock_file.close()
            return None
        return lock_file

    def is_locked(self, lock_name):
        """True when another process currently holds the device lock."""
        lock = self.acquire_lock(lock_name, blocking=False)
        if lock is None:
            return True
        lock.close()
        return False

    def marker(self, udid):
        return self.lock_directory / f'{udid}.managed'

    def device_lock_name(self, udid):
        return f'{udid}.lock'

    def lock_path(self, udid):
        return self.lock_directory / self.device_lock_name(udid)

    # -- 谁占着 ---------------------------------------------------------------

    def write_holder(self, lock_file, payload):
        """把持有者的身份写进锁文件。**必须在持锁状态下调用**，否则两个租约会互相覆盖。"""
        lock_file.seek(0)
        lock_file.truncate()
        json.dump(payload, lock_file, ensure_ascii=False)
        lock_file.flush()
        os.fsync(lock_file.fileno())

    def read_holder(self, udid):
        """读锁文件里的持有者信息；读不到（空文件 / 老格式）就是 None。

        读一个别人正锁着的文件是安全的：`flock` 是劝告锁，内容由持有者独占写。
        """
        try:
            return json.loads(self.lock_path(udid).read_text() or 'null')
        except (OSError, json.JSONDecodeError):
            return None

    def holder_if_locked(self, udid):
        """有人持锁时返回持有者信息，没人持锁返回 None。"""
        lock = self.acquire_lock(self.device_lock_name(udid), blocking=False)
        if lock is not None:
            lock.close()
            return None
        holder = self.read_holder(udid) or {}
        holder['udid'] = udid
        return holder

    def checked_out_by(self, udid, token=None):
        """这个 UDID 的租约状态。返回 `(code, holder)`：

            0 = 我就在这个租约里面（token 对得上，且持有者进程还活着）
            3 = 没有租约（没人持锁）——**别自己挑一台设备**，去租一台
            4 = 租约是别人的（持锁的是另一个进程，或 token 对不上）
        """
        holder = self.holder_if_locked(udid)
        if holder is None:
            stale = self.read_holder(udid) or {}
            stale['udid'] = udid
            return 3, stale
        if token and holder.get('token') == token and holder.get('pid') and process_alive(holder['pid']):
            return 0, holder
        return 4, holder

    def describe_holder(self, holder):
        """一句话说清"谁占着"——没有租约时也要说清，那正是要人自己动手的情形。"""
        if not holder or not holder.get('pid'):
            return '（锁文件里没有留下身份信息：多半是更早版本的 simulator.py 写的）'
        alive = '存活' if process_alive(holder['pid']) else '已退出（租约是残留的）'
        return (
            f"「{holder.get('verifyName', '?')}」租约，持有者 {holder.get('owner', 'unknown')}"
            f"（pid {holder.get('pid')}，{alive}，从 {holder.get('startedAt', '?')} 开始，"
            f"设备 {holder.get('udid', '?')}）"
        )

    # -- lease ---------------------------------------------------------------

    # -- 设备名（只是标签）---------------------------------------------------

    def available_name(self, name, except_udid=None):
        """一个没有别的设备正在用的名字。

        同名不是"不好看"这种问题：两台设备同名时，"按名字找设备"必然只能找到其中一台
        （这台机器上真的出现过两台 `Memoh push acceptance Verify`）。名字只是标签，
        UDID 才是身份；所以撞了就加序号，而不是让两台设备共用一个标签。
        """
        taken = {
            device.get('name')
            for device in device_inventory(self.simctl).get('devices', {}).get(self.runtime, [])
            if device.get('udid') and device.get('udid') != except_udid
        }
        if name not in taken:
            return name
        index = 2
        while f'{name} {index}' in taken:
            index += 1
        return f'{name} {index}'

    @contextmanager
    def lease(self, verify_name, shutdown_after=False, command=None):
        name = managed_name(verify_name)
        self.lock_directory.mkdir(parents=True, exist_ok=True)
        pool_lock = self.acquire_lock('.pool.lock', blocking=True)
        device = None
        device_lock = None
        marker = None
        try:
            inventory = device_inventory(self.simctl)
            installed = inventory.get('devices', {})
            if self.runtime not in installed:
                raise RuntimeError(
                    f'{self.runtime} is not installed on this machine; install a matching iOS '
                    f'Simulator runtime or change RUNTIME in simulator.py. Installed: {", ".join(sorted(installed))}'
                )
            # 挑设备的两条排序理由：
            #   1. **已经叫这个名字的优先**——否则租一次就把别人的设备改了名（改名不改变
            #      身份，但会让"我那台去哪了"变成要查的事）；
            #   2. 冷设备（Shutdown）排在热设备前面——一台开着但没有我们标记的设备是别人
            #      正在用的，先挑不用抢的。
            candidates = sorted(
                reusable_devices(inventory, self.device_type, self.runtime),
                key=lambda candidate: (
                    candidate.get('name') != name,
                    candidate.get('state') != 'Shutdown',
                ),
            )
            # 中间态先摘出去**并说出来**：不发任何 simctl 命令（那会白等 120s），
            # 也不静默跳过（静默会让"为什么又新造了一台设备"变成一个要查的事）。
            stuck = [
                candidate
                for candidate in candidates
                if is_transitional(candidate)
                and not self.is_locked(self.device_lock_name(candidate['udid']))
            ]
            for candidate in stuck:
                print(
                    f"skipping {candidate['name']} ({candidate['udid']}): 卡在 {candidate['state']}"
                    '（没有进程在推进它，simctl 命令不会返回）——先收起它再租：'
                    f' xcrun simctl shutdown {candidate["udid"]}',
                    file=sys.stderr,
                )
            for candidate in candidates:
                if is_transitional(candidate):
                    continue
                candidate_marker = self.marker(candidate['udid'])
                if candidate.get('state') != 'Shutdown' and not candidate_marker.exists():
                    continue
                candidate_lock = self.acquire_lock(self.device_lock_name(candidate['udid']), blocking=False)
                if candidate_lock is not None:
                    device = candidate
                    device_lock = candidate_lock
                    break
            if device is None:
                created = self.simctl('create', self.available_name(name), self.device_type, self.runtime)
                udid = created.stdout.strip()
                if not udid:
                    raise RuntimeError('simctl create produced no device identifier')
                device_lock = self.acquire_lock(self.device_lock_name(udid), blocking=True)
                device = {'udid': udid, 'name': name, 'state': 'Shutdown'}
            marker = self.marker(device['udid'])
            marker.touch()
            token = uuid.uuid4().hex
            self.write_holder(
                device_lock,
                {
                    'owner': os.environ.get('MEMOH_VERIFY_OWNER') or os.environ.get('USER') or 'unknown',
                    'pid': os.getpid(),
                    'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
                    'verifyName': verify_name,
                    'token': token,
                    'command': ' '.join(command or [])[:400],
                },
            )
        except BaseException:
            if device_lock is not None:
                device_lock.close()
            raise
        finally:
            pool_lock.close()

        udid = device['udid']
        operation_failed = False
        try:
            if device.get('state') != 'Shutdown':
                self.simctl('shutdown', udid)
            # 名字是标签：撞了就让开（`except_udid` 把自己排除掉，否则会给自己改名）。
            self.simctl('rename', udid, self.available_name(name, except_udid=udid))
            self.simctl('boot', udid)
            self.simctl('bootstatus', udid, '-b', timeout=BOOT_TIMEOUT)
            yield udid, token
        except BaseException:
            operation_failed = True
            raise
        finally:
            cleanup_error = None
            try:
                if shutdown_after:
                    self.shutdown(udid)
                    marker.unlink(missing_ok=True)
            except Exception as error:
                cleanup_error = error
            finally:
                if not shutdown_after:
                    # Keep the warm device marked: a booted device without the
                    # marker is "someone else's" to every later lease.
                    marker.touch()
                device_lock.close()
            if cleanup_error is not None:
                if operation_failed:
                    print(f'Failed to release Simulator {udid}: {cleanup_error}', file=sys.stderr)
                else:
                    raise cleanup_error

    def shutdown(self, udid):
        """Shut a device down, tolerating the already-shutdown exit code.

        卡在中间态的设备**一条命令都不发**：`simctl shutdown` 对它不会返回（实测 >15s，
        真实代码里由 `run_simctl` 的 120s 超时收场），而它本来也不是"开着"的设备。
        """
        current = find_device_by_udid(device_inventory(self.simctl), udid)
        if current is not None and is_transitional(current):
            return
        shutdown = self.simctl('shutdown', udid, check=False)
        if shutdown.returncode == 0:
            return
        current = find_device_by_udid(device_inventory(self.simctl), udid)
        if current is not None and current.get('state') == 'Shutdown':
            return
        shutdown.check_returncode()

    # -- housekeeping --------------------------------------------------------

    def managed(self):
        return reusable_devices(device_inventory(self.simctl), None, self.runtime)

    def release(self, verify_name):
        """Reclaim one forgotten lease: shut the device down, drop its marker."""
        name = resolve_managed_name(verify_name)
        device = find_device(device_inventory(self.simctl), name, self.runtime)
        if device is None:
            print(f'no managed Simulator named {name!r}')
            return 0
        udid = device['udid']
        if self.is_locked(self.device_lock_name(udid)):
            print(f'{name} ({udid}) is in use; release it after that run ends')
            return 1
        if is_transitional(device):
            # 解除标记是这里**唯一**能做且该做的事：这台设备不归池子管了，而把它从
            # 中间态里推出去是人的活（进程已经没了，我们发命令只会白等）。
            self.marker(udid).unlink(missing_ok=True)
            print(f'{name} ({udid}) 卡在 {device["state"]}：已解除空闲标记（池子不会再挑它）。')
            print(f'  要真正清掉它：xcrun simctl shutdown {udid}（仍不动就重启 CoreSimulatorService）')
            return 0
        self.shutdown(udid)
        self.marker(udid).unlink(missing_ok=True)
        print(f'released {name} ({udid})')
        return 0

    def purge(self):
        """Delete every unlocked managed device; used to clean up CI machines."""
        removed = 0
        for device in self.managed():
            udid = device['udid']
            if self.is_locked(self.device_lock_name(udid)):
                print(f'skipping {device["name"]} ({udid}): in use')
                continue
            self.simctl('delete', udid)
            self.marker(udid).unlink(missing_ok=True)
            print(f'deleted {device["name"]} ({udid})')
            removed += 1
        if not removed:
            print('nothing to purge')
        return 0

    def report(self):
        entries = []
        devices = self.managed()
        names = [device.get('name') for device in devices]
        for device in devices:
            udid = device['udid']
            holder = self.holder_if_locked(udid)
            entries.append(
                {
                    'udid': udid,
                    'name': device['name'],
                    'state': device.get('state'),
                    'deviceType': device.get('deviceTypeIdentifier'),
                    'locked': holder is not None,
                    'holder': holder,
                    # 同名设备要让看的人立刻看见：它们的名字不能用来找设备。
                    'duplicateName': names.count(device.get('name')) > 1,
                    'idleMarker': self.marker(udid).exists(),
                    # 只有"没人持锁"才算卡死：有人持锁时那只是别的租约正在关机/启动。
                    'transitional': is_transitional(device) and holder is None,
                    'dataPath': str(device_data_path(udid)),
                }
            )
        return entries


def find_device_by_udid(inventory, udid):
    for devices in inventory.get('devices', {}).values():
        for device in devices:
            if device.get('udid') == udid:
                return device
    return None


def device_data_path(udid):
    return Path.home() / 'Library/Developer/CoreSimulator/Devices' / udid


def process_alive(pid):
    """持有租约的那个进程还在不在。

    必须在，因为"锁文件里有身份信息"和"有人正占着"是两件事：进程被 kill -9 之后
    `flock` 会由内核释放，但**文件里的内容还留着**。把残留的当成"有人占着"会让
    一台设备永久锁死；把占着的当成残留则会两个人同时用一台。所以两者都要看。
    """
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def run_with_simulator(pool, verify_name, command, environment=None, shutdown_after=False):
    child_environment = os.environ.copy()
    child_environment.update(environment or {})
    with pool.lease(verify_name, shutdown_after=shutdown_after, command=command) as (udid, token):
        child_environment[ENVIRONMENT_VARIABLE] = udid
        # token 让"我真的在这个租约里面"成为可判定的事：光有一个 UDID 值不算，
        # 别人把自己的 shell 导出同一个变量也长这样（那正是有人写死 UDID 的形态）。
        child_environment[TOKEN_VARIABLE] = token
        print(f'leased {managed_name(verify_name)} ({udid})', file=sys.stderr)
        return subprocess.run(command, env=child_environment).returncode


def parse_arguments(argv):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--name', help='Verification name, for example "app-launch"')
    parser.add_argument('--device', choices=DEVICE_TYPES, default='iphone')
    parser.add_argument(
        '--shutdown-after',
        action='store_true',
        help='Shut the Simulator down when the command ends (default: leave it booted for reuse)',
    )
    parser.add_argument('--list', action='store_true', help='List managed Simulators and their locks')
    parser.add_argument('--release', metavar='NAME', help='Shut down and unlock a forgotten lease')
    parser.add_argument('--purge', action='store_true', help='Delete every unlocked managed Simulator')
    parser.add_argument('--json', action='store_true', help='With --list, print JSON')
    parser.add_argument(
        '--check-lease',
        metavar='UDID',
        help='Exit 0 only when a live lease holding this UDID belongs to $MEMOH_VERIFY_LEASE_TOKEN',
    )
    parser.add_argument('command', nargs=argparse.REMAINDER, help='Command to run inside the lease')
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    pool = SimulatorPool(device_type=DEVICE_TYPES[arguments.device])
    if arguments.check_lease:
        token = os.environ.get(TOKEN_VARIABLE)
        code, holder = pool.checked_out_by(arguments.check_lease, token)
        if code == 0:
            print(f'lease ok: {pool.describe_holder(holder)}')
        elif code == 3:
            print(f'{arguments.check_lease} 上没有租约（没人持着它的租约锁）')
        else:
            print(f'{arguments.check_lease} 被{pool.describe_holder(holder)}占着')
        return code
    if arguments.list:
        entries = pool.report()
        if arguments.json:
            print(json.dumps(entries, indent=2))
            return 0
        if not entries:
            print('no managed Simulator; the next lease will create one')
            return 0
        for entry in entries:
            lock = 'in use' if entry['locked'] else 'free'
            marker = 'idle' if entry['idleMarker'] else 'unmarked'
            duplicate = '  ⚠️ 同名（名字不能用来找设备）' if entry['duplicateName'] else ''
            stuck = '  ⚠️ 卡在中间态：租约会跳过它（xcrun simctl shutdown 收掉它）' if entry['transitional'] else ''
            print(f'{entry["state"]:<9} {lock:<7} {marker:<9} {entry["udid"]}  {entry["name"]}{duplicate}{stuck}')
            if entry['holder']:
                print(f'{"":<38}└─ 占用者：{pool.describe_holder(entry["holder"])}')
        return 0
    if arguments.release is not None:
        try:
            resolve_managed_name(arguments.release)
        except ValueError as error:
            raise SystemExit(str(error))
        return pool.release(arguments.release)
    if arguments.purge:
        return pool.purge()
    if not arguments.name:
        raise SystemExit('--name is required unless --list, --release, --purge or --check-lease is used')
    command = arguments.command
    if command and command[0] == '--':
        command = command[1:]
    if not command:
        raise SystemExit('a command is required after --')
    try:
        managed_name(arguments.name)
    except ValueError as error:
        raise SystemExit(str(error))
    return run_with_simulator(pool, arguments.name, command, shutdown_after=arguments.shutdown_after)


if __name__ == '__main__':
    sys.exit(main())
