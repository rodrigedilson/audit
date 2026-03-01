"""Teste de verificação do ambiente."""
import sys


def test_python_version():
    """Verifica se a versão do Python é >= 3.12."""
    assert sys.version_info >= (3, 12), f"Python 3.12+ necessário, encontrado {sys.version}"


def test_imports():
    """Verifica se as dependências principais estão instaladas."""
    import yaml
    import httpx
    import rich

    assert yaml is not None
    assert httpx is not None
    assert rich is not None


def test_project_structure():
    """Verifica se a estrutura do projeto está correta."""
    from pathlib import Path

    project_root = Path(__file__).parent.parent
    assert (project_root / "src").is_dir()
    assert (project_root / "tests").is_dir()
    assert (project_root / "docs").is_dir()
    assert (project_root / "scripts").is_dir()
    assert (project_root / "CLAUDE.md").is_file()
    assert (project_root / "requirements.txt").is_file()
    assert (project_root / ".claude" / "agents" / "software-engineering").is_dir()
