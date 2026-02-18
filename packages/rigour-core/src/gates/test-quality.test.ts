import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFiles = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('../utils/scanner.js', () => ({
    FileScanner: { findFiles: mockFindFiles },
}));

vi.mock('fs-extra', () => ({
    default: {
        readFile: mockReadFile,
        pathExists: vi.fn().mockResolvedValue(false),
        pathExistsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue(''),
        readJson: vi.fn().mockResolvedValue(null),
        readdirSync: vi.fn().mockReturnValue([]),
    },
}));

import { TestQualityGate } from './test-quality.js';

describe('TestQualityGate — JS/TS tests', () => {
    let gate: TestQualityGate;

    beforeEach(() => {
        gate = new TestQualityGate();
        vi.clearAllMocks();
    });

    it('should flag empty test bodies', async () => {
        mockFindFiles.mockResolvedValue(['src/utils.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('Utils', () => {
    it('should do something', () => {
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('empty-test');
    });

    it('should flag tests with no assertions', async () => {
        mockFindFiles.mockResolvedValue(['src/api.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('API', () => {
    it('should fetch data', () => {
        const data = fetchData();
        console.log(data);
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('no-assertion');
    });

    it('should flag tautological assertions', async () => {
        mockFindFiles.mockResolvedValue(['src/basic.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('Basic', () => {
    it('should pass', () => {
        expect(true).toBe(true);
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('tautological');
    });

    it('should flag mock-heavy tests', async () => {
        mockFindFiles.mockResolvedValue(['src/service.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('Service', () => {
    it('should process', () => {
        const mock1 = vi.fn();
        const mock2 = vi.fn();
        const mock3 = vi.fn();
        const mock4 = vi.fn();
        const mock5 = vi.fn();
        const mock6 = vi.fn();
        expect(mock1).toBeDefined();
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('mock-heavy');
    });

    it('should NOT flag well-written tests', async () => {
        mockFindFiles.mockResolvedValue(['src/good.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('Calculator', () => {
    it('should add two numbers', () => {
        const result = add(2, 3);
        expect(result).toBe(5);
    });

    it('should handle negative numbers', () => {
        const result = add(-1, -2);
        expect(result).toBe(-3);
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag tests with expect().toEqual()', async () => {
        mockFindFiles.mockResolvedValue(['src/valid.test.ts']);
        mockReadFile.mockResolvedValue(`
describe('Parser', () => {
    it('should parse JSON', () => {
        const result = parseConfig('{"key": "value"}');
        expect(result).toEqual({ key: 'value' });
    });
});
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should not scan when disabled', async () => {
        const disabled = new TestQualityGate({ enabled: false });
        const failures = await disabled.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
        expect(mockFindFiles).not.toHaveBeenCalled();
    });
});

describe('TestQualityGate — Python tests', () => {
    let gate: TestQualityGate;

    beforeEach(() => {
        gate = new TestQualityGate();
        vi.clearAllMocks();
    });

    it('should flag empty test functions', async () => {
        mockFindFiles.mockResolvedValue(['test_utils.py']);
        mockReadFile.mockResolvedValue(`
def test_something():
    pass
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('empty-test');
    });

    it('should flag tests with no assertions', async () => {
        mockFindFiles.mockResolvedValue(['test_api.py']);
        mockReadFile.mockResolvedValue(`
def test_fetch_data():
    data = fetch_data()
    print(data)
    result = process(data)
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('no-assertion');
    });

    it('should flag tautological Python assertions', async () => {
        mockFindFiles.mockResolvedValue(['test_basic.py']);
        mockReadFile.mockResolvedValue(`
def test_always_passes():
    assert True
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('tautological');
    });

    it('should NOT flag Python tests with real assertions', async () => {
        mockFindFiles.mockResolvedValue(['test_calc.py']);
        mockReadFile.mockResolvedValue(`
def test_addition():
    result = add(2, 3)
    assert result == 5

def test_subtraction():
    result = subtract(5, 3)
    assert result == 2
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag tests using pytest.raises', async () => {
        mockFindFiles.mockResolvedValue(['test_errors.py']);
        mockReadFile.mockResolvedValue(`
def test_invalid_input():
    with pytest.raises(ValueError):
        parse_int("not a number")
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });
});

describe('TestQualityGate — Go tests', () => {
    let gate: TestQualityGate;

    beforeEach(() => {
        gate = new TestQualityGate();
        vi.clearAllMocks();
    });

    it('should flag empty Go test functions', async () => {
        mockFindFiles.mockResolvedValue(['utils_test.go']);
        mockReadFile.mockResolvedValue(`
package utils

import "testing"

func TestSomething(t *testing.T) {
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('empty-test');
    });

    it('should flag Go tests without assertions', async () => {
        mockFindFiles.mockResolvedValue(['calc_test.go']);
        mockReadFile.mockResolvedValue(`
package calc

import "testing"

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    _ = result
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('no-assertion');
    });

    it('should NOT flag Go tests with t.Error assertions', async () => {
        mockFindFiles.mockResolvedValue(['good_test.go']);
        mockReadFile.mockResolvedValue(`
package calc

import "testing"

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    if result != 5 {
        t.Errorf("expected 5, got %d", result)
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag Go tests with testify assertions', async () => {
        mockFindFiles.mockResolvedValue(['testify_test.go']);
        mockReadFile.mockResolvedValue(`
package main

import (
    "testing"
    "github.com/stretchr/testify/assert"
)

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    assert.Equal(t, 5, result)
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });
});

describe('TestQualityGate — Java tests', () => {
    let gate: TestQualityGate;

    beforeEach(() => {
        gate = new TestQualityGate();
        vi.clearAllMocks();
    });

    it('should flag Java tests without assertions', async () => {
        mockFindFiles.mockResolvedValue(['CalcTest.java']);
        mockReadFile.mockResolvedValue(`
import org.junit.jupiter.api.Test;

class CalcTest {
    @Test
    void testAdd() {
        int result = Calculator.add(2, 3);
        System.out.println(result);
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('no-assertion');
    });

    it('should NOT flag Java tests with assertions', async () => {
        mockFindFiles.mockResolvedValue(['GoodTest.java']);
        mockReadFile.mockResolvedValue(`
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GoodTest {
    @Test
    void testAdd() {
        int result = Calculator.add(2, 3);
        assertEquals(5, result);
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures).toHaveLength(0);
    });

    it('should flag tautological Java assertions', async () => {
        mockFindFiles.mockResolvedValue(['TautTest.java']);
        mockReadFile.mockResolvedValue(`
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TautTest {
    @Test
    void testAlwaysPasses() {
        assertTrue(true);
    }
}
        `);

        const failures = await gate.run({ cwd: '/project' });
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(failures[0].details).toContain('tautological');
    });
});
