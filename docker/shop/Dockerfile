# Public build context is assembled by `python3 docker/shop/build.py`.
# Pinned AMD64 Python base includes findmnt and lsblk for host attestation.
FROM ghcr.io/astral-sh/uv@sha256:847b5e690018bc6b9d97a0848da65f721b785f1e78d9c7067b8947c7010b2718
COPY --chmod=0555 space-store /opt/space-store/space-store
COPY --chmod=0555 docker /usr/local/bin/docker
COPY --chmod=0555 docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
COPY --chmod=0555 web/ /opt/space-store/web/
COPY --chmod=0555 bootstrap.py host.py /opt/space-store/
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp DOCKER_CONFIG=/tmp/space-store-docker-config
RUN mkdir /control && chmod 0700 /control
USER 0:0
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD python3 /opt/space-store/bootstrap.py --health
ENTRYPOINT ["python3", "/opt/space-store/bootstrap.py"]
