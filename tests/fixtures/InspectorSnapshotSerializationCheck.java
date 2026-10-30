import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** JVM adapter for failure/counting checks; real Android org.json is benchmarked separately. */
public class InspectorSnapshotSerializationCheck {
    static int serializations, originalSerializations;
    static final class JSONException extends Exception { JSONException() {} }
    static class JSONObject {
        static final Object NULL = new Object();
        final LinkedHashMap<String,Object> values = new LinkedHashMap<>();
        boolean original;
        JSONObject put(String key,Object value) throws JSONException {
            if (value instanceof Double && !Double.isFinite((Double)value)) throw new JSONException();
            if (value == null) values.remove(key); else values.put(key,value);
            return this;
        }
        Object opt(String key) { return values.get(key); }
        Object get(String key) throws JSONException { if(!values.containsKey(key))throw new JSONException();return values.get(key); }
        Iterator<String> keys() { return values.keySet().iterator(); }
        public String toString() {
            serializations++; if(original)originalSerializations++;
            try { return encode(values); } catch(JSONException error) { return null; }
        }
    }
    static String encode(Object value) throws JSONException {
        if(value==null||value==JSONObject.NULL)return "null";
        if(value instanceof JSONObject)return encode(((JSONObject)value).values);
        if(value instanceof Map) {
            StringBuilder text=new StringBuilder("{");boolean first=true;
            for(Map.Entry<?,?> item:((Map<?,?>)value).entrySet()) {
                if(!first)text.append(',');first=false;
                text.append(quote((String)item.getKey())).append(':').append(encode(item.getValue()));
            }
            return text.append('}').toString();
        }
        if(value instanceof Iterable) {
            StringBuilder text=new StringBuilder("[");boolean first=true;
            for(Object item:(Iterable<?>)value){if(!first)text.append(',');first=false;text.append(encode(item));}
            return text.append(']').toString();
        }
        if(value instanceof Boolean)return value.toString();
        if(value instanceof Number) {
            if(value instanceof Double&&!Double.isFinite((Double)value))throw new JSONException();
            return value.toString();
        }
        return quote(value.toString());
    }
    static String quote(String value) {
        StringBuilder text=new StringBuilder("\"");
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            switch(c) {
                case '"':text.append("\\\"");break;
                case '\\':text.append("\\\\");break;
                case '/':text.append("\\/");break;
                case '\b':text.append("\\b");break;
                case '\f':text.append("\\f");break;
                case '\n':text.append("\\n");break;
                case '\r':text.append("\\r");break;
                case '\t':text.append("\\t");break;
                default:if(c<32)text.append(String.format(java.util.Locale.ROOT,"\\u%04x",(int)c));else text.append(c);
            }
        }
        return text.append('"').toString();
    }
    /* SERIALIZER */
    static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    static JSONObject snapshot(String screenshot) throws Exception {
        JSONObject json=new JSONObject().put("success",true).put("has_screenshot",true).put("screenshot_format","png").put("screenshot_base64",screenshot);
        json.original=true;return json;
    }
    static String repeated(int length) { char[] chars=new char[length];Arrays.fill(chars,'A');return new String(chars); }
    static int branchSextet(char value) {
        if(value>='A'&&value<='Z')return value-'A';
        if(value>='a'&&value<='z')return value-'a'+26;
        if(value>='0'&&value<='9')return value-'0'+52;
        if(value=='+')return 62;
        if(value=='/')return 63;
        return -1;
    }
    static void emit(String label,JSONObject original,boolean fast) throws Exception {
        LinkedHashMap<String,Object> identity=new LinkedHashMap<>(original.values);
        String before=original.toString();serializations=originalSerializations=0;
        String result=InspectorSnapshotJson.stringify(original);
        check(serializations==1,"exactly one serializer invocation: "+label);
        check(originalSerializations==(fast?0:1),"fast/fallback dispatch: "+label);
        check(original.values.equals(identity),"source object mutated: "+label);
        for(String key:identity.keySet())check(original.opt(key)==identity.get(key),"nested identity changed: "+label);
        LinkedHashMap<String,Object> row=new LinkedHashMap<>();
        row.put("label",label);row.put("original",before);row.put("encoded",result);
        row.put("utf8Length",result.getBytes(StandardCharsets.UTF_8).length);
        java.lang.System.out.println(encode(row));
    }
    public static void main(String[] args) throws Exception {
        Method sextet=InspectorSnapshotJson.class.getDeclaredMethod("sextet",char.class);sextet.setAccessible(true);
        for(int value=Character.MIN_VALUE;value<=Character.MAX_VALUE;value++) {
            check(((Integer)sextet.invoke(null,(char)value))==branchSextet((char)value),"character mapping differs: "+value);
        }
        String png=args[0];
        JSONObject rich=snapshot(png);
        rich.put("hierarchy_xml","<node text=\"中文/🙂\">\u0000\b\f\n\r\t\u001f\\\"</node>");
        rich.put("quoted/key\"\\\u0000",Arrays.asList(true,12,-0.25,JSONObject.NULL,"é/中🙂\u2028\u2029"));
        JSONObject nested=new JSONObject().put("null",JSONObject.NULL).put("nested",Arrays.asList("/","\u0001",false));
        rich.put("helperObservation",nested);
        emit("png-and-unicode",rich,true);
        for(String text:new String[]{"AA==","AAA=","AAAA","////","/w==","//8="})emit("canonical-"+text,snapshot(text),true);
        for(String text:new String[]{"","A","AAA","AAAAA","====","AA=A","A===","AA==AAAA","AA\n=","AA =","AA\"=","AA\\=","AB==","AAB=","__==","éAAA"})emit("invalid-"+text,snapshot(text),false);
        for(String field:new String[]{"success","has_screenshot","screenshot_format","screenshot_base64"}) {
            JSONObject missing=snapshot(png);missing.values.remove(field);emit("missing-"+field,missing,false);
            JSONObject wrong=snapshot(png);wrong.values.put(field,field.equals("screenshot_base64")?12:"true");emit("wrong-"+field,wrong,false);
        }
        JSONObject failed=snapshot(png);failed.put("success",false);failed.put("error","failure/中文");emit("failure",failed,false);
        JSONObject noScreenshot=snapshot(png);noScreenshot.put("has_screenshot",false);emit("no-screenshot",noScreenshot,false);
        JSONObject limit=snapshot(repeated(24*1024*1024));serializations=originalSerializations=0;
        String limitText=InspectorSnapshotJson.stringify(limit);
        check(limitText.length()>24*1024*1024&&serializations==1&&originalSerializations==0,"inclusive Base64 fast-path limit");
        limitText=null;limit=null;
        JSONObject oversize=snapshot(repeated(24*1024*1024+4));serializations=originalSerializations=0;
        check(InspectorSnapshotJson.stringify(oversize)!=null&&serializations==1&&originalSerializations==1,"overcap must fallback, not reject");
        JSONObject invalidNumber=snapshot(png);invalidNumber.values.put("nonfinite",Double.NaN);serializations=originalSerializations=0;
        check(InspectorSnapshotJson.stringify(invalidNumber)==null&&serializations==0&&originalSerializations==0,"copy error must preserve null without serializing twice");
        JSONObject nestedInvalid=snapshot(png);JSONObject bad=new JSONObject();bad.values.put("nonfinite",Double.POSITIVE_INFINITY);nestedInvalid.put("nested",bad);
        serializations=originalSerializations=0;
        check(InspectorSnapshotJson.stringify(nestedInvalid)==null&&serializations==1&&originalSerializations==0,"nested encoding null must not fallback");
        final int[] bombCalls={0};JSONObject bomb=snapshot(png);bomb.put("bomb",new Object(){public String toString(){bombCalls[0]++;throw new IllegalStateException("test failure");}});
        serializations=originalSerializations=0;
        try{InspectorSnapshotJson.stringify(bomb);throw new AssertionError("runtime exception swallowed");}catch(IllegalStateException expected){}
        check(bombCalls[0]==1&&serializations==1&&originalSerializations==0,"runtime exception retried");
        JSONObject subclass=new JSONObject(){public String toString(){originalSerializations++;return "subclass";}};
        subclass.values.putAll(snapshot(png).values);originalSerializations=0;
        check("subclass".equals(InspectorSnapshotJson.stringify(subclass))&&originalSerializations==1,"subclass behavior changed");
        try{InspectorSnapshotJson.stringify(null);throw new AssertionError("null input changed");}catch(NullPointerException expected){}
        final int[] fallbackCalls={0};JSONObject fallbackBomb=snapshot("not base64");
        fallbackBomb.put("bomb",new Object(){public String toString(){fallbackCalls[0]++;throw new IllegalStateException("fallback test");}});
        serializations=originalSerializations=0;
        try{InspectorSnapshotJson.stringify(fallbackBomb);throw new AssertionError("fallback exception swallowed");}catch(IllegalStateException expected){}
        check(fallbackCalls[0]==1&&serializations==1&&originalSerializations==1,"fallback exception retried");
        Method capacity=InspectorSnapshotJson.class.getDeclaredMethod("assembledCapacity",int.class,int.class);capacity.setAccessible(true);
        try{capacity.invoke(null,Integer.MAX_VALUE,4);throw new AssertionError("capacity overflow accepted");}
        catch(InvocationTargetException expected){check(expected.getCause() instanceof OutOfMemoryError,"wrong capacity overflow behavior");}
        java.lang.System.out.println("checked canonical limits, original identity, null/runtime failure, single serialization and allocation overflow");
    }
}
