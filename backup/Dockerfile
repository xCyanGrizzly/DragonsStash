FROM postgres:16-alpine

RUN apk add --no-cache bash restic coreutils

COPY scripts/backup/container-entrypoint.sh /usr/local/bin/dragons-stash-backup
RUN chmod 0755 /usr/local/bin/dragons-stash-backup

ENTRYPOINT ["/usr/local/bin/dragons-stash-backup"]
