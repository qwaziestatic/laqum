# deploy/secrets

Mounted read-only into the backup container at `/run/secrets`. Never
committed (only this file is).

- `backup_key`: the private SSH key the backup copies with (`ssh-keygen -t
ed25519 -N '' -f deploy/secrets/backup_key`); its `.pub` goes in the
  second location's `~/.ssh/authorized_keys`.
- `backup_known_hosts`: that machine's host key, pinned (`ssh-keyscan -t
ed25519 <host> > deploy/secrets/backup_known_hosts`, then compare the
  fingerprint with the one the machine itself shows).

See docs/DEPLOY.md, "Backups".
