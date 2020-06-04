#!/usr/bin/env python
# Copyright (c) 2013 The Native Client Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.
"""Tool for generating list of ports in code.google.com wiki format.
"""

from __future__ import print_function

import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NACLPORTS_ROOT = os.path.dirname(SCRIPT_DIR)

sys.path.append(os.path.join(NACLPORTS_ROOT, 'lib'))

import naclports
import naclports.source_package

SRC_URL = 'https://chromium.googlesource.com/external/naclports/+/master'

header = '''\
#summary List of ports available in naclports.
= List of available !NaCl ports =

Port are listed in alphabetical order, with links to the upstream
source archive and the patch used when building for !NaCl.
This listing is auto-generated by the
[%s/build_tools/generate_port_list.py generate_port_list.py]
script.

|| *Name* || *Version* || *Upstream Archive* || *!NaCl Patch* || *Libc* \
|| *Arch* || *Builds on* ||''' % SRC_URL


def OutputTableRow(package):
  if not package.URL:
    return
  patch = os.path.join(package.root, 'nacl.patch')
  if os.path.exists(patch):
    relative_path = os.path.relpath(patch, NACLPORTS_ROOT)
    size = os.path.getsize(patch)
    if size < 1024:
      patch = '[%s/%s %d B]' % (SRC_URL, relative_path, size)
    else:
      patch = '[%s/%s %d KiB]' % (SRC_URL, relative_path, size / 1024)
  else:
    patch = ''
  url = '[%s %s]' % (package.URL, package.GetArchiveFilename())
  package_url = '[%s/%s %s]' % (SRC_URL,
                                os.path.relpath(package.root, NACLPORTS_ROOT),
                                package.NAME)

  libc = package.LIBC
  if libc:
    libc = libc + '-only'
  else:
    disabled_libc = getattr(package, 'DISABLED_LIBC')
    if disabled_libc:
      libc = 'not ' + ' or '.join(disabled_libc)
    else:
      libc = ''

  disabled_arch = getattr(package, 'DISABLED_ARCH')
  if disabled_arch:
    arch = 'not ' + ' or '.join(disabled_arch)
  else:
    arch = ''

  host = package.BUILD_OS
  if host:
    host = host + '-only'
  else:
    host = ''
  cols = (package_url, package.VERSION, url, patch, libc, arch, host)
  print('|| %-70s || %-10s || %-50s || %s || %s || %s || %s ||' % cols)


def main(args):
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument('-v', '--verbose', action='store_true',
                      help='Output extra information.')
  parser.parse_args(args)
  rtn = 0

  print(header)

  total = 0
  for package in sorted(naclports.source_package.SourcePackageIterator()):
    OutputTableRow(package)
    total += 1

  print('\n_Total = %d_\n' % total)

  print('= Local Ports (not based on upstream sources) =\n')
  total = 0
  for package in naclports.source_package.SourcePackageIterator():
    if package.URL:
      continue
    package_url = '[%s/%s %s]' % (SRC_URL,
                                  os.path.relpath(package.root, NACLPORTS_ROOT),
                                  package.NAME)
    print('|| %-70s ||' % package_url)
    total += 1
  print('\n_Total = %d_\n' % total)

  return rtn


if __name__ == '__main__':
  sys.exit(main(sys.argv[1:]))
