#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Frontend/FrontendActions.h"
#include "clang/Tooling/CompilationDatabase.h"
#include "clang/Tooling/Tooling.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

using namespace clang;
static llvm::json::Array functions, calls;
class Visitor : public RecursiveASTVisitor<Visitor> {
  ASTContext &context;
  llvm::json::Object position(SourceLocation location) {
    const auto &manager=context.getSourceManager();
    auto spelling=manager.getSpellingLoc(location);
    return llvm::json::Object{ {"file",manager.getFilename(spelling).str()}, {"offset",static_cast<int64_t>(manager.getFileOffset(spelling))} };
  }
 public:
  explicit Visitor(ASTContext &context):context(context){}
  bool VisitFunctionDecl(FunctionDecl *function) {
    if(!function->doesThisDeclarationHaveABody())return true;
    auto item=position(function->getBeginLoc());
    item["name"]=function->getQualifiedNameAsString();
    item["type"]=function->getType().getAsString();
    item["macro"]=function->getBeginLoc().isMacroID();
    auto method=dyn_cast<CXXMethodDecl>(function);
    item["virtual"]=method && method->isVirtual();
    functions.push_back(std::move(item));return true;
  }
  bool VisitCallExpr(CallExpr *call) {
    auto item=position(call->getBeginLoc());item["macro"]=call->getBeginLoc().isMacroID();
    if(auto callee=call->getDirectCallee()) {
      auto method=dyn_cast<CXXMethodDecl>(callee);
      item["virtual"]=method && method->isVirtual();
      auto definition=callee->getDefinition();
      item["target"]=position(definition?definition->getBeginLoc():callee->getBeginLoc());
    }
    calls.push_back(std::move(item));return true;
  }
};
class Consumer : public ASTConsumer {
 public:
  void HandleTranslationUnit(ASTContext &context) override { Visitor visitor(context);visitor.TraverseDecl(context.getTranslationUnitDecl()); }
};
class Action : public ASTFrontendAction {
 public:
  std::unique_ptr<ASTConsumer> CreateASTConsumer(CompilerInstance &,llvm::StringRef) override {return std::make_unique<Consumer>();}
};
int main(int argc,const char **argv) {
  if(argc<3)return 2;
  std::vector<std::string> args;for(int index=3;index<argc;index++)args.push_back(argv[index]);
  tooling::FixedCompilationDatabase database(argv[2],args);
  tooling::ClangTool tool(database,{argv[1]});
  int status=tool.run(tooling::newFrontendActionFactory<Action>().get());
  llvm::outs()<<llvm::json::Value(llvm::json::Object{{"functions",std::move(functions)},{"calls",std::move(calls)}})<<"\n";
  return status;
}
