FROM postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
RUN useradd --uid 994 --no-create-home --shell /usr/sbin/nologin zstore
