BINARY  := halo-gateway
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)
DIST    := dist

.PHONY: build test race lint docker cross clean

build:
	go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(BINARY) ./cmd/gateway

test:
	go test ./...

race:
	go test -race ./...

lint:
	go vet ./...
	gofmt -l . | tee /dev/stderr | test -z "$$(cat)"

docker:
	docker build -t halo-gateway:$(VERSION) --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) .

cross:
	GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(BINARY)-linux-amd64  ./cmd/gateway
	GOOS=linux  GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(BINARY)-linux-arm64  ./cmd/gateway
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(BINARY)-darwin-arm64 ./cmd/gateway

clean:
	rm -rf $(DIST)
