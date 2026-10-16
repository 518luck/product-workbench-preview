#pragma once
#include <atomic>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <iomanip>
#include <initializer_list>
#include <mutex>
#include <sstream>
#include <string>
#include <type_traits>
#include <unistd.h>
#include <vector>

namespace __pb {
inline std::mutex mutex;
inline std::atomic<unsigned long long> spans{0};
inline unsigned long long sequence=0;
inline std::string quote(const std::string& text) { std::string result="\"";const char* hex="0123456789abcdef";for(unsigned char ch:text){if(ch=='"'||ch=='\\'){result+='\\';result+=ch;}else if(ch<32){result+="\\u00";result+=hex[ch>>4];result+=hex[ch&15];}else result+=ch;}return result+'"'; }
inline std::string runID=[](){const char* file=std::getenv("PRODUCT_BLUEPRINT_PROBE_CONFIG");std::ifstream stream(file?file:"");std::stringstream text;text<<stream.rdbuf();auto data=text.str();auto start=data.find("\"runId\":\"");if(start==std::string::npos)return std::string{};start+=9;return data.substr(start,data.find('"',start)-start);}();
template<class T> std::string scalar(T value){if constexpr(std::is_same_v<T,bool>)return value?"true":"false";else{std::ostringstream text;text<<std::setprecision(17)<<value;return text.str();}}
template<class T> std::string valueType(){return std::is_same_v<T,bool>?"boolean":"number";}
struct Frame;
struct Pending {std::string id,target;std::vector<std::string> sources;std::string entered,returned;};
inline thread_local std::vector<Frame*> stack;
inline thread_local Pending* pending=nullptr;
struct Frame {
  std::string id,trace,unit,call,returned;
  Frame* parent=nullptr;
  Pending* link=nullptr;
  int exceptions=std::uncaught_exceptions();
  Frame(const std::string&,std::initializer_list<std::string>,std::initializer_list<std::string>);
  ~Frame();
};
inline void emit(const std::string& kind,const Frame& frame,const std::string& extra=""){
  std::lock_guard<std::mutex> lock(mutex);
  auto text="{\"runId\":"+quote(runID)+",\"seq\":"+std::to_string(++sequence)+",\"kind\":"+quote(kind)+",\"traceId\":"+quote(frame.trace)+",\"spanId\":"+quote(frame.id)+",\"unitId\":"+quote(frame.unit)+",\"parentSpanId\":"+(frame.parent?quote(frame.parent->id):"null")+",\"parentUnitId\":"+(frame.parent?quote(frame.parent->unit):"null")+extra+"}\n";
  ::write(3,text.data(),text.size());
}
inline Frame::Frame(const std::string& unitID,std::initializer_list<std::string> ids,std::initializer_list<std::string> values):id(std::to_string(++spans)),trace(id),unit(unitID){
  if(pending&&pending->target==unit&&!stack.empty()){parent=stack.back();trace=parent->trace;call=pending->id;link=pending;link->entered=id;}
  stack.push_back(this);pending=nullptr;emit("enter",*this,",\"callId\":"+quote(call));
  auto value=values.begin();unsigned index=0;for(const auto& fact:ids){if(value==values.end())break;if(link&&index<link->sources.size())emit("binding",*this,",\"sourceId\":"+quote(link->sources[index])+",\"targetId\":"+quote(fact)+",\"sourceSpanId\":"+quote(parent->id)+",\"targetSpanId\":"+quote(id)+",\"callId\":"+quote(call));emit("value",*this,",\"factId\":"+quote(fact)+",\"rawScalar\":"+*value++);index++;}
}
inline Frame::~Frame(){emit(std::uncaught_exceptions()>exceptions?"throw":"exit",*this);if(link)link->returned=returned;stack.pop_back();}
template<class T> T returned(Frame& frame,const std::string& fact,T value){frame.returned=fact;emit("return",frame,",\"factId\":"+quote(fact)+",\"valueType\":"+quote(valueType<T>())+",\"rawScalar\":"+scalar(value));return value;}
inline bool branch(Frame& frame,const std::string& point,bool value){emit("branch",frame,",\"pointId\":"+quote(point)+",\"decision\":"+(value?"true":"false")+",\"rawScalar\":"+(value?"true":"false"));return value;}
template<class T> T point(Frame& frame,const std::string& point,T value){emit("point",frame,",\"pointId\":"+quote(point));return value;}
template<class F> auto invoke(Frame& frame,const std::string& id,const std::string& target,const std::string& result,std::initializer_list<std::string> sources,F&& callback){
  Pending call{id,target,std::vector<std::string>(sources),"",""};auto previous=pending;pending=&call;
  struct Restore {Pending* value;~Restore(){pending=value;}} restore{previous};
  emit("call",frame,",\"callId\":"+quote(id)+",\"targetUnitId\":"+quote(target));auto value=callback();
  if(!call.entered.empty()&&!call.returned.empty())emit("binding",frame,",\"sourceId\":"+quote(call.returned)+",\"targetId\":"+quote(result)+",\"sourceSpanId\":"+quote(call.entered)+",\"targetSpanId\":"+quote(frame.id)+",\"callId\":"+quote(id));
  emit("value",frame,",\"factId\":"+quote(result)+",\"valueType\":"+quote(valueType<decltype(value)>())+",\"rawScalar\":"+scalar(value));return value;
}
}
