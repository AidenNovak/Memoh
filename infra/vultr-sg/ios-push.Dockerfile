# syntax=docker/dockerfile:1
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ios-push-gateway ./cmd/ios-push-gateway
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/ios-push-gateway ./cmd/ios-push-gateway

FROM alpine:latest
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/ios-push-gateway /usr/local/bin/ios-push-gateway
EXPOSE 8083
ENTRYPOINT ["/usr/local/bin/ios-push-gateway"]
