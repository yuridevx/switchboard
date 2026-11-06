// Функции Go для конвейера слопиков: go run gofuncs.go <папка>; печатает [{file, name, line, toks, lits}].
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type fn struct {
	File string   `json:"file"`
	Name string   `json:"name"`
	Line int      `json:"line"`
	Toks []string `json:"toks"`
	Lits []string `json:"lits"`
}

// tokens нормализует тело: имя — I, литерал — L, остальное — вид лексемы.
func tokens(src []byte) ([]string, []string) {
	fset := token.NewFileSet()
	var s scanner.Scanner
	s.Init(fset.AddFile("", fset.Base(), len(src)), src, nil, 0)
	toks := []string{}
	lits := []string{}
	for {
		_, t, lit := s.Scan()
		if t == token.EOF {
			return toks, lits
		}
		switch {
		case t == token.IDENT:
			toks = append(toks, "I")
		case t == token.STRING:
			toks = append(toks, "L")
			if v, err := strconv.Unquote(lit); err == nil && len(v) >= 4 && !strings.Contains(v, "\n") {
				lits = append(lits, v)
			}
		case t.IsLiteral():
			toks = append(toks, "L")
		default:
			toks = append(toks, t.String())
		}
	}
}

func main() {
	out := []fn{}
	err := filepath.WalkDir(os.Args[1], func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			f, ok := decl.(*ast.FuncDecl)
			if !ok || f.Body == nil {
				continue
			}
			start, end := fset.Position(f.Body.Pos()).Offset, fset.Position(f.Body.End()).Offset
			toks, lits := tokens(src[start:end])
			out = append(out, fn{filepath.ToSlash(path), f.Name.Name, fset.Position(f.Pos()).Line, toks, lits})
		}
		return nil
	})
	if err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
