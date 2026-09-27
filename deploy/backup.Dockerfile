# Nightly database dumps. pg_dump from the same major version as the server
# (16), plus rsync and ssh to copy each dump to the second location.
FROM postgres:16.15-alpine
RUN apk add --no-cache rsync openssh-client
COPY deploy/backup.sh /usr/local/bin/laqum-backup
RUN chmod 0755 /usr/local/bin/laqum-backup
ENTRYPOINT ["laqum-backup"]
CMD ["schedule"]
