# Multi-stage build for the bichito presence/relay server.
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd -m bichito
USER bichito
COPY --from=build /app/target/release/bichito-server /usr/local/bin/bichito-server
ENV PORT=8787
EXPOSE 8787
CMD ["bichito-server"]
