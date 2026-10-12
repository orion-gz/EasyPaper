import ast
import asyncio
import contextlib
from pathlib import Path
import sys
import types

source = Path('backend/routers/library.py').read_text()
module = ast.parse(source)
names = {'get_library_trash', 'empty_library_trash'}
functions = [node for node in module.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
for function in functions:
    function.decorator_list = []
    function.returns = None
    for arg in function.args.args:
        arg.annotation = None
    function.args.defaults = [ast.Constant(None) for _ in function.args.defaults]
docs = [{'id': 'research-trash', 'document_mode': 'research'}, {'id': 'general-trash', 'document_mode': 'general'}]
deleted = []
queries = []
def list_documents(*args, **kwargs):
    queries.append(kwargs)
    mode = kwargs.get('document_mode')
    return [doc for doc in docs if mode is None or doc['document_mode'] == mode]
@contextlib.asynccontextmanager
async def quiesce_document(doc_id):
    yield
sys.modules['services'] = types.ModuleType('services')
workers = types.ModuleType('services.document_workers')
workers.quiesce_document = quiesce_document
sys.modules['services.document_workers'] = workers
namespace = {'list_documents': list_documents, 'permanently_delete_document': deleted.append}
exec(compile(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])), '<actual library router functions>', 'exec'), namespace)
async def main():
    visible = await namespace['get_library_trash'](document_mode='research', current_user='audit')
    await namespace['empty_library_trash'](current_user='audit')
    print({'visible': [doc['id'] for doc in visible['documents']], 'permanently_deleted': deleted, 'queries': queries})
    assert deleted == ['research-trash', 'general-trash']
asyncio.run(main())
