HELPER  := halo-update-helper
PACKER  := halo-update-packer
LDFLAGS := -s -w
DIST    := dist

.PHONY: build helper packer test race lint clean

build: helper packer

# The helper ships inside the Windows install directory.
helper:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(HELPER).exe ./cmd/halo-update-helper

# The packer runs on the build machine.
packer:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/$(PACKER) ./cmd/halo-update-packer

test:
	go test ./...

race:
	go test -race ./...

lint:
	go vet ./...
	gofmt -l . | tee /dev/stderr | test -z "$$(cat)"

clean:
	rm -rf $(DIST)
