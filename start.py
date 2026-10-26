"""Start Yapling Observatory from a checkout or extracted ZIP."""
import sys


if __name__ == "__main__":
    if sys.version_info < (3, 11):
        print("Python 3.11 or newer is required: https://www.python.org/downloads/", file=sys.stderr)
        sys.exit(1)
    sys.dont_write_bytecode = True
    from scripts.start import main

    sys.exit(main())
