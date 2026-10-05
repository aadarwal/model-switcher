// fzf, as far as the mesh picker (src/mesh.ts) drives it: a bash script for a
// test's stub directory, written with `stubDir().stub("fzf", FZF_STUB)`.
//
// It reads the rows on stdin the way fzf does and "selects" one without a
// terminal, by name. Everything is steered from the environment, so one script
// serves every test:
//
//   MS_TEST_FZF_PICK     the account to select: the first row whose text, ANSI
//                        stripped, has the name as a word. No match is fzf's
//                        own "nothing matched", exit 1.
//   MS_TEST_FZF_EXIT     exit with this instead of selecting (130 = esc).
//   MS_TEST_FZF_ARGS     write the argv here, NUL-separated (the header has a
//                        newline in it, so one-per-line would not do).
//   MS_TEST_FZF_RELOAD   press ctrl-r first: run the `reload(...)` command
//                        the way fzf would, through a shell, and select from
//                        what IT printed.
//   MS_TEST_FZF_ROWS     write the rows it selects from here.
//   MS_TEST_FZF_PREVIEW  run `--preview` for the selected row (with `{1}`
//                        replaced by the row's quoted key, as fzf does) and
//                        write what it printed here.
//   MS_TEST_FZF_VERSION  what `fzf --version` answers (default 0.73.1).
//
// No `${…}` anywhere, so the script can sit in a String.raw template as-is.
export const FZF_STUB = String.raw`if [ "$1" = "--version" ]; then
  v=$MS_TEST_FZF_VERSION; [ -n "$v" ] || v=0.73.1
  echo "$v (stub)"; exit 0
fi
[ -z "$MS_TEST_FZF_ARGS" ] || printf '%s\0' "$@" > "$MS_TEST_FZF_ARGS"
rows=$(cat)
preview=""; bind=""
while [ $# -gt 0 ]; do
  case "$1" in
    --preview) preview="$2"; shift 2 ;;
    --bind) bind="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$MS_TEST_FZF_RELOAD" ]; then
  cmd=$(printf '%s' "$bind" | sed -e 's/^ctrl-r:reload.//' -e 's/.+refresh-preview$//')
  rows=$(sh -c "$cmd") || exit 2
fi
[ -z "$MS_TEST_FZF_ROWS" ] || printf '%s\n' "$rows" > "$MS_TEST_FZF_ROWS"
code=$MS_TEST_FZF_EXIT; [ -n "$code" ] || code=0
[ "$code" = 0 ] || exit "$code"
esc=$(printf '\033')
line=""
while IFS= read -r l; do
  plain=$(printf '%s' "$l" | sed "s/$esc\[[0-9;]*m//g")
  case " $plain " in *" $MS_TEST_FZF_PICK "*) line="$l"; break ;; esac
done <<EOF_ROWS
$rows
EOF_ROWS
[ -n "$line" ] || exit 1
key=$(printf '%s\n' "$line" | cut -f1)
if [ -n "$MS_TEST_FZF_PREVIEW" ]; then
  base=$(printf '%s' "$preview" | sed 's/{1}$//')
  sh -c "$base'$key'" > "$MS_TEST_FZF_PREVIEW"
fi
printf '%s\n' "$line"`;
