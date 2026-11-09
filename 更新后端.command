#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash deploy/update.sh
status=$?
printf '\n'
if test "$status" -eq 0; then
    echo '后端更新完成。'
else
    echo '更新未完成，请保留上面的错误信息。不要重复使用已发布的版本号。'
fi
read -r -p '按回车关闭窗口…' _
exit "$status"
