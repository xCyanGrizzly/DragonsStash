FROM alpine:3.20

RUN apk add --no-cache restic postgresql16-client curl tzdata dcron tar bash

COPY backup/backup.sh /backup.sh
COPY backup/entrypoint.sh /entrypoint.sh
COPY backup/crontab /etc/crontabs/root

RUN chmod +x /backup.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
