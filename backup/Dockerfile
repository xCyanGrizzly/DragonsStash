FROM alpine:3.20

# Note: use busybox's built-in crond (Alpine base), NOT the dcron package —
# dcron's crond fails with "setpgid: Operation not permitted" in this runtime.
RUN apk add --no-cache restic postgresql16-client curl tzdata tar bash

COPY backup/backup.sh /backup.sh
COPY backup/entrypoint.sh /entrypoint.sh
COPY backup/crontab /etc/crontabs/root

RUN chmod +x /backup.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
