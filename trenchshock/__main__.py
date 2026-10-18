import argparse
import webbrowser

from .server import serve


def main():
    parser = argparse.ArgumentParser(description="Trench Shock — Python battle engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not args.no_browser:
        webbrowser.open(f"http://{args.host}:{args.port}")
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
