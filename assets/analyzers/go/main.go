package main

import (
	"encoding/json"
	"go/ast"
	"go/token"
	"go/types"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
	"os"
)

type Position struct {
	File   string `json:"file"`
	Offset int    `json:"offset"`
}
type Function struct {
	Position
	Name       string   `json:"name"`
	Result     string   `json:"result"`
	Parameters []string `json:"parameters"`
}
type Call struct {
	Position
	Target    *Position `json:"target"`
	Invoke    bool      `json:"invoke"`
	Arguments []string  `json:"arguments"`
}
type Report struct {
	Functions []Function `json:"functions"`
	Calls     []Call     `json:"calls"`
	Gaps      []string   `json:"gaps"`
}

func main() {
	report := Report{Functions: []Function{}, Calls: []Call{}, Gaps: []string{}}
	root := os.Args[1]
	set := token.NewFileSet()
	pkgs, err := packages.Load(&packages.Config{Dir: root, Fset: set, Mode: packages.LoadSyntax, Tests: false, Env: append(os.Environ(), "GOPACKAGESDRIVER=off", "GOWORK=off", "GOPROXY=off", "GOTOOLCHAIN=local")}, "./...")
	if err != nil {
		report.Gaps = append(report.Gaps, err.Error())
	}
	position := func(pos token.Pos) Position { p := set.PositionFor(pos, false); return Position{p.Filename, p.Offset} }
	valid := []*packages.Package{}
	for _, pkg := range pkgs {
		if pkg.IllTyped {
			for _, err := range pkg.Errors {
				report.Gaps = append(report.Gaps, err.Error())
			}
			continue
		}
		valid = append(valid, pkg)
		for _, file := range pkg.Syntax {
			ast.Inspect(file, func(node ast.Node) bool {
				fn, ok := node.(*ast.FuncDecl)
				if !ok {
					return true
				}
				object, ok := pkg.TypesInfo.Defs[fn.Name].(*types.Func)
				if !ok {
					return true
				}
				sig := object.Type().(*types.Signature)
				item := Function{Position: position(fn.Pos()), Name: fn.Name.Name, Parameters: []string{}}
				for i := 0; i < sig.Params().Len(); i++ {
					item.Parameters = append(item.Parameters, types.TypeString(sig.Params().At(i).Type(), nil))
				}
				if sig.Results().Len() == 1 {
					item.Result = types.TypeString(sig.Results().At(0).Type(), nil)
				}
				report.Functions = append(report.Functions, item)
				return true
			})
		}
	}
	prog, _ := ssautil.Packages(valid, ssa.InstantiateGenerics)
	prog.Build()
	for fn := range ssautil.AllFunctions(prog) {
		if fn.Pkg == nil || fn.Pkg.Pkg == nil {
			continue
		}
		for _, block := range fn.Blocks {
			for _, instruction := range block.Instrs {
				call, ok := instruction.(ssa.CallInstruction)
				if !ok || call.Pos() == token.NoPos {
					continue
				}
				common := call.Common()
				item := Call{Position: position(call.Pos()), Invoke: common.IsInvoke(), Arguments: []string{}}
				if callee := common.StaticCallee(); callee != nil && callee.Pos() != token.NoPos {
					p := position(callee.Pos())
					item.Target = &p
				}
				for _, arg := range common.Args {
					item.Arguments = append(item.Arguments, arg.String())
				}
				report.Calls = append(report.Calls, item)
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(report)
}
