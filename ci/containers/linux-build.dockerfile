FROM node:22.16-bullseye@sha256:f16d8e8af67bb6361231e932b8b3e7afa040cbfed181719a450b02c3821b26c1
WORKDIR /
# this is only valid in dockerfiles, OCI compliant files don't support it.
# ie you have to run podman build --format docker
SHELL ["/bin/bash", "-c"]

# Install emscripten to compile C dependencies into WASM
RUN git clone https://github.com/emscripten-core/emsdk.git \
    && emsdk/emsdk install 3.1.59 \
    && emsdk/emsdk activate 3.1.59 \
    && source emsdk/emsdk_env.sh
ENV PATH="$PATH:/emsdk/upstream/bin:/emsdk/upstream/emscripten"

# Install FPM to package desktop clients and deb packages. FPM needs ruby
RUN apt-get update && apt-get install -y ruby && gem install fpm:1.15.1

# Install pkcs11-tool from OpenSC to sign desktop clients and deb packages
# Note: `osslsigncode` is used on Windows as well
RUN apt-get install -y opensc usbutils pcsc-tools osslsigncode libengine-pkcs11-openssl

# Install graphiz to make the bundles graph
RUN apt-get install -y graphviz

# Install Rust to build the Tuta SDK
COPY download-rust.sh download-rust.sh
RUN ./download-rust.sh
