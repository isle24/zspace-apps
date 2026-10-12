# Official Astral publisher amd64 Python 3.13/bookworm-slim manifest.
# Includes Python3, findmnt and lsblk; no mutable apt/pip/tool downloads.
FROM ghcr.io/astral-sh/uv@sha256:847b5e690018bc6b9d97a0848da65f721b785f1e78d9c7067b8947c7010b2718
COPY --chmod=0555 space-store /opt/space-store/space-store
COPY --chmod=0555 docker /usr/local/bin/docker
COPY --chmod=0555 docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
COPY --chmod=0555 web/ /opt/space-store/web/
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp DOCKER_CONFIG=/tmp/space-store-docker-config
USER 65534:65534
ENTRYPOINT ["/opt/space-store/space-store"]
