#!/usr/bin/env python3
"""Compare a release's immutable SQL files with Prisma's actual migration history."""
import argparse
import json
import re
from pathlib import Path


def applied(path):
    result = {}
    for row in json.loads(Path(path).read_text()):
        if row['rolled_back']:
            continue
        if not row['completed']:
            raise ValueError('数据库存在未完成的迁移，需先人工排查，更新已停止。')
        name, checksum = row['name'], row['checksum']
        if name in result:
            raise ValueError('数据库迁移记录重复，更新已停止。')
        result[name] = checksum
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'snapshot'])
    parser.add_argument('expected')
    parser.add_argument('observed')
    parser.add_argument('--same', action='store_true')
    args = parser.parse_args()
    actual = applied(args.observed)
    if args.action == 'snapshot':
        Path(args.expected).write_text(json.dumps(actual, indent=2) + '\n')
        return
    expected = json.loads(Path(args.expected).read_text())
    if not isinstance(expected, dict) or not expected:
        raise ValueError('发布包缺少有效的数据库迁移清单。')
    for name, checksum in expected.items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or not re.fullmatch(r'[a-f0-9]{64}', checksum):
            raise ValueError('数据库迁移清单格式错误。')
    for name, checksum in actual.items():
        if expected.get(name) != checksum:
            raise ValueError(f'已上线迁移被修改或移除：{name}。请保留旧迁移，另建新迁移。')
    pending = len(expected.keys() - actual.keys())
    if args.same and pending:
        raise ValueError('目标版本的数据库结构与当前不同，不能自动回滚代码。请人工确认结构兼容性。')
    print(pending)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError) as error:
        raise SystemExit(str(error))
